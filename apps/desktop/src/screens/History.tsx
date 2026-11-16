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
import { getNotes, MAX_NOTE, setNote } from '../lib/txNotes';
import { useAsync } from '../lib/useAsync';
import { EmptyState, ErrorLine, PasswordField } from '../components/kit';
import { DISPLAY, Glass, GlassButton, LABEL, Tabs } from '../components/kyro';
import { GlassSearch, coinTint } from '../components/kyroParts';
import { TronNoHistoryLine, tronNoHistory } from '../components/ServerDown';
import { HistoryRow, LoadingLine, entryTitle } from '../components/HistoryRow';
import { ReplaceDialog } from '../components/ReplaceTx';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Notice, Skeleton, Spinner } from '../components/ui/primitives';
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
  const [query, setQuery] = useState('');
  const { t, tp, lang } = useT();
  const cur = settings.currency;
  const priceOf = (e: HistoryEntry) => (e.asset ? pf.price(e.asset.coingeckoId)?.price ?? null : null);
  // Private notes: this device only (lib/txNotes.ts).
  const [notes, setNotes] = useState<Record<string, string>>(() => getNotes(network));
  useEffect(() => setNotes(getNotes(network)), [network]);
  const [editing, setEditing] = useState<string | null>(null);
  const noteOf = (e: HistoryEntry) => notes[`${e.chainKey}:${e.id}`];
  const saveNote = (e: HistoryEntry, text: string) => {
    setNote(network, e.chainKey, e.id, text);
    setNotes(getNotes(network));
    setEditing(null);
  };

  // A lone « Loading… » only for the first seconds; then what is there, with a small « Updating… ».
  const [grace, setGrace] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setGrace(false), 3000);
    return () => window.clearTimeout(id);
  }, []);
  const down = history.data ? unreachable(history.data, tronNoHistory) : null;
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (history.data?.entries ?? []).filter((e) => matches(e, filter) && (!q || [entryTitle(e), e.asset?.symbol, e.asset?.name, e.chainLabel, e.counterparty, e.id, e.note, noteOf(e)].some((x) => x?.toLowerCase().includes(q))));
  }, [history.data, filter, query, lang, notes]);
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
    const rows: Array<Array<string | number>> = [[t('history.csvDate'), t('history.csvNetwork'), t('history.csvType'), t('history.csvDirection'), t('history.csvAsset'), t('history.csvAmount'), t('history.csvFee'), t('history.csvCounterparty'), t('history.csvStatus'), t('history.csvId'), t('history.csvNote')]];
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
        noteOf(e) ?? '',
      ]);
    }
    downloadText(t('history.csvFileName', { network, date: new Date().toISOString().slice(0, 10) }), toCsv(rows));
  };

  const pending = (history.data?.entries ?? []).filter((e) => e.status === 'pending').length;
  const [approvalCount, setApprovalCount] = useState<{ all: number; risky: number }>({ all: 0, risky: 0 });
  const toApprovals = () => document.getElementById('history-approvals')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
      <div className="mx-auto mt-8 flex w-full max-w-[964px] flex-col px-8 pb-10">
        <header className="flex flex-wrap items-center gap-y-3 pb-5">
          <h1 className="m-0 text-[22px] leading-none" style={{ ...DISPLAY, fontWeight: 400, letterSpacing: '-0.03em' }}>
            {t('common.history')}
          </h1>
          <span className="ml-10">
          <Tabs<Filter>
            label={t('history.filter')}
            value={filter}
            onChange={setFilter}
            items={[
              { id: 'all', label: t('history.filterAll') },
              { id: 'in', label: t('history.filterIn') },
              { id: 'out', label: t('history.filterOut') },
              { id: 'swap', label: t('history.filterSwaps') },
              { id: 'approval', label: t('history.filterApprovals') },
            ]}
          />
          </span>
          <div className="ml-auto flex items-center gap-2">
            <GlassSearch value={query} onChange={setQuery} placeholder={t('history.search')} label={t('history.search')} className="w-[200px]" />
          </div>
        </header>

        <div key={`${filter}:${history.data ? 'data' : 'loading'}`} className="flex flex-col">
          {history.loading && !(grace && groups.length === 0) && (
            <p role="status" className="m-0 flex items-center gap-2 pb-2 text-[12px] text-faint">
              <Spinner className="size-3" />
              {t('history.updating')}
            </p>
          )}
          {history.loading && grace && groups.length === 0 ? (
            <LoadingLine />
          ) : groups.length === 0 ? (
            <EmptyState title={query.trim() ? t('history.noMatch') : t('history.noTransactions')}>
              {query.trim() ? null : history.loading && history.data ? t('history.checking', { done: history.data.known.length, total: history.data.chains.length }) : filter === 'all' ? t('history.noTransactionsHint') : t('history.nothingForFilter')}
            </EmptyState>
          ) : (
            groups.map((g, gi) => (
              <div key={g.label} className="stagger flex flex-col">
                <div className="grid grid-cols-[52px_28px_minmax(0,1fr)] items-center pt-2 pb-1.5" style={idx(gi * 3)}>
                  <span />
                  <span className="relative flex h-full justify-center">
                    <span className="absolute inset-y-0 w-px bg-white/[.08]" />
                  </span>
                  <span className={cn(LABEL, 'pl-2')}>
                    {g.label}
                  </span>
                </div>
                {g.items.map((e, i) => {
                  const node = e.kind === 'approval' ? '#cfe7ff' : coinTint(e.asset?.color);
                  return (
                    <div key={e.id} className="grid grid-cols-[52px_28px_minmax(0,1fr)] items-stretch">
                      <span className="figure self-center pr-3 text-right text-[11.5px] text-faint">{e.time ? fmtDate(e.time, { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                      <span className="relative flex items-center justify-center">
                        <span className="absolute inset-y-0 w-px bg-white/[.08]" />
                        <span className="relative size-[7px]" style={{ background: node, boxShadow: e.status === 'pending' ? '0 0 10px #7cc4ff' : `0 0 6px ${node}66` }} />
                      </span>
                      <div className="ml-2 min-w-0">
                        <HistoryRow
                          i={gi * 3 + i + 1}
                          e={e}
                          timeline
                          price={priceOf(e)}
                          currency={cur}
                          hidden={hideBalances}
                          extra={
                            editing === `${e.chainKey}:${e.id}` ? (
                              <NoteInput initial={noteOf(e) ?? ''} onSave={(text) => saveNote(e, text)} onCancel={() => setEditing(null)} />
                            ) : noteOf(e) ? (
                              <button type="button" onClick={() => setEditing(`${e.chainKey}:${e.id}`)} title={t('history.noteEdit')} className="mt-1 max-w-full truncate text-left text-[12px] text-text2 hover:text-text">
                                {noteOf(e)}
                              </button>
                            ) : null
                          }
                          action={
                            !activeWatch && canReplace(e, e.asset?.family) ? (
                              <>
                                <GlassButton className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => setReplacing({ entry: e, mode: 'speedUp' })}>
                                  {t('history.speedUp')}
                                </GlassButton>
                                <GlassButton className="h-8 rounded-[10px] px-3 text-[12px] font-medium text-text2" onClick={() => setReplacing({ entry: e, mode: 'cancel' })}>
                                  {t('history.cancelTx')}
                                </GlassButton>
                              </>
                            ) : !noteOf(e) && editing !== `${e.chainKey}:${e.id}` ? (
                              <button type="button" onClick={() => setEditing(`${e.chainKey}:${e.id}`)} className="press rounded-[8px] px-2 py-1 text-[12px] text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-text focus-visible:opacity-100">
                                {t('history.noteAdd')}
                              </button>
                            ) : undefined
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
          <div className="flex flex-col gap-1.5 pt-4 pl-[88px] text-[12px] leading-[1.5]">
            {history.data && Object.entries(history.data.errors).some(([, v]) => tronNoHistory(v)) && <TronNoHistoryLine />}
            {down && down.keys.length > 0 &&
              (down.all ? (
                <ErrorLine onRetry={history.reload} error={Object.values(history.data?.errors ?? {}).join(' ')}>
                  {t('history.partial')}
                </ErrorLine>
              ) : (
                <p role="status" className="m-0 text-faint">
                  {t('history.unreachable', { networks: down.keys.map((k) => findChain(network, k)?.label ?? k).join(', ') })}
                  {' · '}
                  <button type="button" onClick={history.reload} className="text-mute underline-offset-2 hover:text-text hover:underline">
                    {t('history.retry')}
                  </button>
                </p>
              ))}
            {history.data?.dotHistory === 'unavailable' && <p className="m-0 text-mute">{t('history.dotUnavailable')}</p>}
            {history.data?.dotHistory === 'partial' && <p className="m-0 text-mute">{t('history.dotPartial')}</p>}
            {history.data?.btcCapped && <p className="m-0 text-mute">{t('history.btcCapped', { cap: BTC_TXS_CAP })}</p>}
            <p className="m-0 text-faint">{t('history.ethNote')}</p>
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px]">
          <span className={LABEL}>{month.label}</span>
          <span className="figure text-up">{t('history.received')} {hideBalances ? '•••' : `+${fmtFiat(month.received, cur, { decimals: 0 })}`}</span>
          <span className="text-faint">·</span>
          <span className="figure text-text2">{t('history.sent')} {hideBalances ? '•••' : `−${fmtFiat(month.sent, cur, { decimals: 0 })}`}</span>
          <span className="text-faint">·</span>
          <span className="figure text-text2">{t('history.fees')} {hideBalances ? '•••' : fmtFiat(month.fees, cur)}</span>
          {pending > 0 && (
            <>
              <span className="text-faint">·</span>
              <span className="text-mute">{tp('history.pendingCount', pending)}</span>
            </>
          )}
          {approvalCount.all > 0 && (
            <button type="button" onClick={toApprovals} className={cn('flex items-center gap-1.5 hover:underline', approvalCount.risky > 0 ? 'text-down' : 'text-mute')}>
              <span className={cn('size-[5px]', approvalCount.risky > 0 ? 'bg-down' : 'bg-ice')} />
              {t('history.activeApprovals')} · {approvalCount.all}
              {approvalCount.risky > 0 && <> · {t('history.atRisk', { count: approvalCount.risky })}</>}
            </button>
          )}
          <GlassButton className="ml-auto h-9 rounded-[12px] px-3 text-[12.5px] font-medium" onClick={exportCsv} disabled={!history.data?.entries.length}>
            <IconImport size={14} /> {t('history.exportCsv')}
          </GlassButton>
        </div>

        <Approvals onCount={setApprovalCount} />
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

/** Inline note field: Enter saves (empty removes the note), Escape cancels. */
function NoteInput({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const { t } = useT();
  const [text, setText] = useState(initial);
  return (
    <span className="mt-1.5 flex items-center gap-2">
      <input
        autoFocus
        value={text}
        maxLength={MAX_NOTE}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') onSave(text);
          else if (ev.key === 'Escape') onCancel();
        }}
        placeholder={t('history.notePlaceholder')}
        aria-label={t('history.noteLabel')}
        className="h-8 min-w-0 flex-1 rounded-[10px] bg-white/[.05] px-3 text-[12.5px] text-text ring-1 ring-white/[.08] focus:ring-white/[.2]"
      />
      <GlassButton className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onSave(text)}>
        {t('common.save')}
      </GlassButton>
    </span>
  );
}

interface LiveApproval extends ApprovalRecord {
  current: bigint;
}

function Approvals({ onCount }: { onCount: (n: { all: number; risky: number }) => void }) {
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
  useEffect(() => onCount({ all: list.length, risky }), [list.length, risky]);

  return (
    <section id="history-approvals" aria-label={t('history.activeApprovals')} className="mt-10 flex scroll-mt-4 flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className={LABEL}>{t('history.activeApprovals')}</span>
        {risky > 0 && <Badge tone="down">{t('history.atRisk', { count: risky })}</Badge>}
      </div>
      {list.length > 0 && <p className="m-0 max-w-[620px] text-[13px] leading-[1.55] text-mute">{t('history.approvalsHint')}</p>}
      {state.loading && !state.data && <Skeleton className="h-24 w-full" />}
      {state.data && list.length === 0 && <p className="m-0 text-[13px] text-mute">{t('history.noApprovals')}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {list.map((a) => {
          const unlimited = isUnlimitedAllowance(a.current);
          const asset = assetsFor(network).find((x) => x.contract?.toLowerCase() === a.token.toLowerCase());
          return (
            <Glass key={`${a.chainId}:${a.token}:${a.spender}`} className="fade-in flex flex-col gap-2.5 rounded-[18px] px-4 py-3.5" style={unlimited ? { boxShadow: 'inset 0 0 0 1px rgba(255,99,99,.35), inset 0 1px 0 rgba(255,255,255,.06)' } : undefined}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13.5px] font-semibold">
                  {a.tokenSymbol} → {a.spenderLabel}
                </span>
                <span className={cn('figure text-[13px] font-semibold', unlimited ? 'text-down' : 'text-text2')}>{unlimited ? t('history.unlimited') : fmtCrypto(a.current, a.tokenDecimals, a.tokenSymbol)}</span>
              </div>
              <span className="text-[12px] text-mute">
                {shortAddress(a.spender)} · {t('history.grantedOn', { date: fmtDate(a.time, { day: 'numeric', month: 'short' }) })} · {asset ? (pf.holdings.find((h) => h.asset.id === asset.id) ? t('history.balanceExposed') : '') : ''}
              </span>
              <Button variant={unlimited ? 'danger' : 'outline'} size="md" onClick={() => setRevoking(a)}>
                {t('history.revoke')}
              </Button>
            </Glass>
          );
        })}
      </div>
      {revoking && (
        <RevokeDialog
          approval={revoking}
          onClose={(done) => {
            setRevoking(null);
            if (done) state.reload();
          }}
        />
      )}
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
