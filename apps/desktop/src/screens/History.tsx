// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo, useState } from 'react';
import { BTC_TXS_CAP, toIpcError } from '@kyro/shared';
import { assetsFor, findAsset, unitsToNumber } from '@kyro/chains';
import { buildRevoke, isUnlimitedAllowance } from '@kyro/swap';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { useHistory, type HistoryEntry } from '../state/history';
import { useOnTorReady } from '../state/tor';
import { useOnCbfSynced } from '../state/cbf';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtDayGroup, fmtFiat, fmtMonth, shortAddress } from '../lib/format';
import { addLocalTx, getApprovals, removeApproval, type ApprovalRecord } from '../lib/storage';
import { downloadText, toCsv } from '../lib/csv';
import { useAsync } from '../lib/useAsync';
import { EmptyState, ErrorLine, PasswordField } from '../components/kit';
import { TronNoHistoryLine, tronNoHistory } from '../components/ServerDown';
import { HistoryRow, entryTitle } from '../components/HistoryRow';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Notice, Segmented, Skeleton, Spinner } from '../components/ui/primitives';
import { IconImport } from '../components/icons';

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
  const pf = usePortfolio();
  const history = useHistory();
  useOnTorReady(history.reload);
  useOnCbfSynced(history.reload);
  const [filter, setFilter] = useState<Filter>('all');
  const cur = settings.currency;
  const priceOf = (e: HistoryEntry) => (e.asset ? pf.price(e.asset.coingeckoId)?.price ?? null : null);

  const entries = useMemo(() => (history.data?.entries ?? []).filter((e) => matches(e, filter)), [history.data, filter]);
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: HistoryEntry[] }> = [];
    for (const e of entries) {
      const label = e.time ? fmtDayGroup(e.time) : 'En cours';
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [entries]);

  // Current month summary at today's prices.
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
  }, [history.data, pf]);

  const exportCsv = () => {
    const rows: Array<Array<string | number>> = [['date', 'réseau', 'type', 'sens', 'actif', 'montant', 'frais', 'contrepartie', 'statut', 'identifiant']];
    for (const e of history.data?.entries ?? []) {
      rows.push([
        e.time ? new Date(e.time).toISOString() : '',
        e.chainLabel,
        e.kind,
        e.direction,
        e.asset?.symbol ?? e.assetId,
        e.asset ? fmtCrypto(e.amount, e.asset.decimals, undefined, e.asset.decimals).replace(/ /g, '') : e.amount.toString(),
        e.fee && e.feeAsset ? fmtCrypto(e.fee, e.feeAsset.decimals, e.feeAsset.symbol, e.feeAsset.decimals).replace(/ /g, ' ') : '',
        e.counterparty ?? '',
        e.status,
        e.id,
      ]);
    }
    downloadText(`kyro-historique-${network}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
  };

  const pending = (history.data?.entries ?? []).filter((e) => e.status === 'pending').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-[26px] py-[22px]">
      <header className="flex items-center justify-between gap-4">
        <h1 className="m-0 text-[28px] font-semibold tracking-[-0.03em]">Historique</h1>
        <div className="flex items-center gap-2.5">
          <Segmented<Filter>
            label="Filtre"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'Tout' },
              { value: 'out', label: 'Envois' },
              { value: 'in', label: 'Réceptions' },
              { value: 'swap', label: 'Swaps' },
              { value: 'approval', label: 'Autorisations' },
            ]}
          />
          <Button variant="outline" size="lg" onClick={exportCsv} disabled={!history.data?.entries.length}>
            <IconImport size={15} /> Exporter CSV
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-line bg-card">
          <div className="min-h-0 flex-1 overflow-y-auto py-2 scroll-thin">
            {history.loading && !history.data ? (
              <div className="flex flex-col gap-3 p-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-11 w-full" />)}</div>
            ) : groups.length === 0 ? (
              <EmptyState title="Aucune transaction">{filter === 'all' ? 'Tes envois, réceptions, swaps et autorisations apparaîtront ici.' : 'Rien pour ce filtre.'}</EmptyState>
            ) : (
              groups.map((g) => (
                <div key={g.label}>
                  <div className="px-[22px] pt-3 pb-2 text-[13px] font-semibold text-mute">{g.label}</div>
                  {g.items.map((e) => (
                    <HistoryRow key={e.id} e={e} price={priceOf(e)} currency={cur} hidden={hideBalances} />
                  ))}
                </div>
              ))
            )}
            {history.data && Object.entries(history.data.errors).some(([, v]) => tronNoHistory(v)) && <TronNoHistoryLine className="px-5 py-3" />}
            {history.data && Object.entries(history.data.errors).some(([, v]) => !tronNoHistory(v)) && (
              <ErrorLine className="px-5 py-3" onRetry={history.reload} error={Object.values(history.data.errors).filter((v) => !tronNoHistory(v)).join(' ')}>
                Historique partiel : {Object.entries(history.data.errors).filter(([, v]) => !tronNoHistory(v)).map(([k, v]) => `${k} (${v})`).join(', ')}
              </ErrorLine>
            )}
            {history.data?.btcCapped && (
              <p className="m-0 px-[22px] pt-3 text-[12px] leading-[1.5] text-mute">
                Bitcoin : {BTC_TXS_CAP} dernières transactions par adresse. Les plus anciennes ne sont pas listées (limite du serveur), ton solde reste exact.
              </p>
            )}
            <p className="m-0 px-[22px] py-3 text-[11px] leading-[1.5] text-faint">
              Sans indexeur tiers, les envois d’ETH natif n’apparaissent que s’ils ont été faits depuis cet appareil. Les transferts ERC-20 des {network === 'testnet' ? '5 000' : '5 000'} derniers blocs sont lus directement sur le nœud.
            </p>
          </div>
        </section>

        <div className="flex w-[380px] shrink-0 flex-col gap-4">
          <section className="flex flex-col gap-3.5 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
            <span className="text-[15px] font-semibold">{month.label}</span>
            <div className="grid grid-cols-3 gap-2">
              <MonthStat label="Reçu" value={hideBalances ? '•••' : `+${fmtFiat(month.received, cur, { decimals: 0 })}`} tone="text-up" />
              <MonthStat label="Envoyé" value={hideBalances ? '•••' : `−${fmtFiat(month.sent, cur, { decimals: 0 })}`} />
              <MonthStat label="Frais" value={hideBalances ? '•••' : fmtFiat(month.fees, cur)} />
            </div>
            <span className="text-[11px] text-faint">Au cours actuel.{pending ? ` ${pending} transaction${pending > 1 ? 's' : ''} en attente.` : ''}</span>
          </section>
          <Approvals />
        </div>
      </div>
    </div>
  );
}

function MonthStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[12px] bg-raised px-3 py-2.5">
      <span className="text-[12px] text-mute">{label}</span>
      <span className={cn('truncate text-[16px] font-semibold', tone)}>{value}</span>
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
  const risky = list.filter((a) => isUnlimitedAllowance(a.current)).length;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-[22px] border border-line bg-card px-[22px] py-[18px] scroll-thin">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold">Autorisations actives</span>
        {risky > 0 && <Badge tone="down">{risky} à risque</Badge>}
      </div>
      <p className="m-0 text-[13px] leading-[1.55] text-mute">Ces contrats peuvent encore dépenser tes tokens. Révoque ce dont tu ne te sers plus.</p>
      {state.loading && !state.data && <Skeleton className="h-24 w-full" />}
      {state.data && list.length === 0 && <EmptyState className="py-6" title="Aucune autorisation ouverte">Les autorisations accordées depuis Kyro sont suivies ici.</EmptyState>}
      {list.map((a) => {
        const unlimited = isUnlimitedAllowance(a.current);
        const asset = assetsFor(network).find((x) => x.contract?.toLowerCase() === a.token.toLowerCase());
        return (
          <div key={`${a.chainId}:${a.token}:${a.spender}`} className={cn('flex flex-col gap-2.5 rounded-[16px] border px-4 py-3.5', unlimited ? 'border-down/40' : 'border-line')}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] font-semibold">
                {a.tokenSymbol} → {a.spenderLabel}
              </span>
              <span className={cn('text-[13px] font-semibold', unlimited ? 'text-down' : 'text-text2')}>{unlimited ? 'Illimité' : fmtCrypto(a.current, a.tokenDecimals, a.tokenSymbol)}</span>
            </div>
            <span className="text-[12px] text-mute">
              {shortAddress(a.spender)} · accordée le {new Date(a.time).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · {asset ? pf.holdings.find((h) => h.asset.id === asset.id) ? 'solde exposé' : '' : ''}
            </span>
            <Button variant={unlimited ? 'danger' : 'outline'} size="md" onClick={() => setRevoking(a)}>
              Révoquer
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ad = adapters.evm.get(approval.chainKey);
  const token = findAsset(network, `erc20:${approval.chainId}:${approval.token.toLowerCase()}`);

  const revoke = async () => {
    if (!ad || !token) return;
    setBusy(true);
    setError(null);
    try {
      const fees = await ad.estimateFees();
      const fee = fees.options.normal.params;
      if (fee.family !== 'evm') throw new Error('Frais indisponibles');
      const call = buildRevoke(approval.token, approval.spender);
      const unsigned = await ad.buildCall({ to: call.to, data: call.data, fee, kind: 'approval', asset: token, amount: 0n, token: { symbol: token.symbol, decimals: token.decimals } });
      const decoded = await ad.decode(unsigned);
      if (decoded.kind !== 'Erc20Approve' || decoded.amount !== '0' || decoded.spender?.toLowerCase() !== approval.spender.toLowerCase()) throw new Error('Décodage inattendu : arrêt.');
      const signed = await ad.signTx(unsigned, pw);
      const hash = await ad.broadcast(signed);
      removeApproval(network, approval.chainId, approval.token, approval.spender);
      addLocalTx({ id: hash, network, chainKey: approval.chainKey, assetId: token.id, kind: 'approval', direction: 'self', amount: '0', label: `Révocation ${approval.tokenSymbol} pour ${approval.spenderLabel}`, time: Date.now(), status: 'pending' });
      onClose(true);
    } catch (e) {
      const err = toIpcError(e);
      setError(err.code === 'USER_REJECTED' ? 'Signature annulée.' : err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)} title={`Révoquer ${approval.tokenSymbol} → ${approval.spenderLabel}`}>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">
        Une transaction <span className="font-mono">approve(spender, 0)</span> remet l’autorisation à zéro. Elle coûte des frais de réseau, comme un envoi.
      </p>
      <PasswordField id="revoke-pw" value={pw} onChange={setPw} autoFocus onEnter={() => pw && void revoke()} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={() => onClose(false)} disabled={busy}>
          Annuler
        </Button>
        <Button variant="danger" disabled={!pw || busy || !token} onClick={() => void revoke()}>
          {busy && <Spinner />} Révoquer
        </Button>
      </div>
    </Dialog>
  );
}

export { entryTitle };
