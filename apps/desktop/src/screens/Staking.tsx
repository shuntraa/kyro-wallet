// SPDX-License-Identifier: GPL-3.0-or-later
// Staking (docs/IPC.md §2.8): Solana (native Stake program), Cardano (pool + vote delegation), TRON
// (Stake 2.0 + SR votes).

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CHAIN_COLORS, tryParseUnits } from '@kyro/chains';
import {
  call,
  toIpcError,
  type AdaPool,
  type AdaStakeOverview,
  type Commands,
  type SolStakeOverview,
  type SolStakePosition,
  type SolValidator,
  type TronResource,
  type TronStakeAccount,
  type TronWitness,
} from '@kyro/shared';
import { useApp, useVault } from '../state/app';
import { useOnTorReady } from '../state/tor';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtNumber, fmtWhen, sanitizeDecimalInput, shortAddress, toInputDecimal } from '../lib/format';
import { useAsync, useNow } from '../lib/useAsync';
import {
  adaPoolBadges,
  adaWarningText,
  drepArg,
  drepLabel,
  fmtDuration,
  fmtStake,
  networkLabel,
  solStateLabel,
  solStateTone,
  solValidatorBadges,
  solWarningText,
  sortPools,
  sortValidators,
  sortWitnesses,
  tronVotes,
  tronWarningText,
  tronWitnessBadges,
  type AdaSort,
  type DrepMode,
  type SolSort,
  type StakeChain,
  type TronSort,
} from '../lib/staking';
import { CoinIcon, CopyButton, EmptyState, EnClair, ErrorLine, HIDDEN, PasswordField } from '../components/kit';
import { instructionLabel } from '../components/SolSummaryView';
import { SecondConfirmNotice } from '../components/SecondConfirm';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Card, Input, Notice, Segmented, Skeleton, Spinner } from '../components/ui/primitives';
import { IconCheck, IconChevronRight, IconInfo, IconShield, IconWarn } from '../components/icons';
import { idx } from '../components/motion';
import { AccountPicker } from '../components/AccountPicker';
import { getLanguage, t as tNow, useT } from '../i18n';
import { rt } from '../i18n/rich';

function useStakeAccount(): (chain: StakeChain) => { account?: number } {
  const { selectedAccounts } = useApp();
  return (chain) => (selectedAccounts[chain] ? { account: selectedAccounts[chain] } : {});
}

type Ret<K extends keyof Commands> = Commands[K]['ret'];

const SOL = { decimals: 9, symbol: 'SOL' };
const ADA = { decimals: 6, symbol: 'ADA' };
const TRX = { decimals: 6, symbol: 'TRX' };
const amt = (v: string | bigint | null | undefined, u: { decimals: number; symbol: string }) => (v === null || v === undefined ? '—' : fmtCrypto(BigInt(v), u.decimals, u.symbol, u.decimals));

const pc = (n: number, maxFrac = 0) => (getLanguage() === 'fr' ? `${fmtNumber(n, maxFrac)} %` : `${fmtNumber(n, maxFrac)}%`);
const bold = { b: (c: ReactNode) => <strong className="font-semibold text-text">{c}</strong> };
const bold2 = { b: (c: ReactNode) => <strong className="font-semibold text-text2">{c}</strong> };

export function Staking({ chain }: { chain?: StakeChain }) {
  const { activeHw, navigate, hwOnly } = useApp();
  const { accounts } = useVault();
  const { t } = useT();
  const tab: 'home' | StakeChain = chain ?? 'home';
  const has: Record<StakeChain, boolean> = { sol: !!accounts.sol, ada: !!accounts.cardano, tron: !!accounts.tron };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 pt-7 pb-6 scroll-thin">
      <header className="flex items-end justify-between gap-4">
        <h1 className="screen-title">{t('staking.title')}</h1>
        {tab !== 'home' && !activeHw && <AccountPicker family={tab} />}
        <Segmented
          label={t('staking.chain')}
          value={tab}
          onChange={(v) => navigate(v === 'home' ? { name: 'staking' } : { name: 'staking', chain: v })}
          options={[
            { value: 'home', label: t('staking.overview') },
            { value: 'sol', label: 'Solana', disabled: !!activeHw || !has.sol },
            { value: 'ada', label: 'Cardano', disabled: !!activeHw || !has.ada },
            { value: 'tron', label: 'TRON', disabled: !!activeHw || !has.tron },
          ]}
        />
      </header>
      {activeHw && (
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          <strong className="font-semibold text-text">{t('staking.hwTitle')}</strong> {t('staking.hwBody', { label: activeHw.label })} {hwOnly ? t('staking.hwOnly') : t('staking.hwSwitch')}
        </Notice>
      )}
      {tab === 'home' || activeHw ? <StakingHome disabled={!!activeHw} has={has} /> : tab === 'sol' ? <SolStaking /> : tab === 'ada' ? <AdaStaking /> : <TronStaking />}
    </div>
  );
}

function StakingHome({ disabled, has }: { disabled: boolean; has: Record<StakeChain, boolean> }) {
  const { navigate, network, hideBalances } = useApp();
  const acct = useStakeAccount();
  const { t, tp } = useT();
  const sol = useAsync(!disabled && has.sol ? () => call('sol_stake_overview', acct('sol')) : null, [disabled, has.sol, acct('sol').account]);
  const ada = useAsync(!disabled && has.ada ? () => call('ada_stake_overview', acct('ada')) : null, [disabled, has.ada, acct('ada').account]);
  const tron = useAsync(!disabled && has.tron ? () => call('tron_stake_overview', acct('tron')) : null, [disabled, has.tron, acct('tron').account]);
  useOnTorReady(() => {
    sol.reload();
    ada.reload();
    tron.reload();
  });
  const solStaked = sol.data?.accounts.reduce((s, a) => s + BigInt(a.lamports), 0n);
  const tronStaked = tron.data ? BigInt(tron.data.stakedBandwidth) + BigInt(tron.data.stakedEnergy) : undefined;
  const hide = (s: string) => (hideBalances ? HIDDEN : s);
  const cards: { chain: StakeChain; name: string; glyph: string; color: string; what: string; line: ReactNode; error: Error | null }[] = [
    {
      chain: 'sol',
      name: 'Solana',
      glyph: 'S',
      color: CHAIN_COLORS.solana,
      what: t('staking.homeSolWhat'),
      line: sol.data ? tp('staking.homeSolLine', sol.data.accounts.length, { amount: hide(amt(solStaked, SOL)) }) : null,
      error: sol.error,
    },
    {
      chain: 'ada',
      name: 'Cardano',
      glyph: 'A',
      color: '#3468D1',
      what: t('staking.homeAdaWhat'),
      line: ada.data ? (ada.data.stake.registered ? t('staking.homeAdaLine', { pool: ada.data.pool?.ticker ?? shortAddress(ada.data.stake.delegatedPool ?? '—'), amount: hide(amt(ada.data.stake.rewardsAvailable, ADA)) }) : t('staking.homeAdaNone')) : null,
      error: ada.error,
    },
    {
      chain: 'tron',
      name: 'TRON',
      glyph: 'T',
      color: '#EB0029',
      what: t('staking.homeTronWhat', { delay: network === 'mainnet' ? t('staking.homeTronDelayMainnet') : t('staking.homeTronDelayTestnet') }),
      line: tron.data ? t('staking.homeTronLine', { amount: hide(amt(tronStaked, TRX)), used: tron.data.tronPowerUsed, limit: tron.data.tronPowerLimit }) : null,
      error: tron.error,
    },
  ];
  return (
    <>
      <div className="grid shrink-0 grid-cols-3 divide-x divide-line overflow-hidden rounded-panel border border-line bg-card">
        {cards.map((c, i) => (
          <div key={c.chain} className="rise group flex flex-col gap-3 px-5 pt-4 pb-5" style={idx(i)}>
            <div className="flex items-center gap-2.5">
              <CoinIcon glyph={c.glyph} color={c.color} id={c.chain} size={26} />
              <span className="text-[20px] font-semibold tracking-[-0.02em]">{c.name}</span>
              <span className="text-[12px] text-mute">{networkLabel(c.chain, network)}</span>
            </div>
            <p className="m-0 text-[13px] leading-[1.55] text-text2">{c.what}</p>
            <div className="min-h-5 border-t border-line pt-3 text-[13px] font-medium">
              {disabled || !has[c.chain] ? (
                <span className="font-normal text-mute">{disabled ? t('staking.homeHwUnavailable') : t('staking.homeNoAccount')}</span>
              ) : c.error ? (
                <ErrorLine error={c.error}>{c.error.message}</ErrorLine>
              ) : (
                c.line ?? <Skeleton className="h-4 w-48" />
              )}
            </div>
            <div className="flex-1" />
            <Button variant="outline" className="justify-between" disabled={disabled || !has[c.chain]} onClick={() => navigate({ name: 'staking', chain: c.chain })}>
              {t('staking.homeOpen', { chain: c.name })}
              <IconChevronRight size={15} className="nudge text-mute" />
            </Button>
          </div>
        ))}
      </div>
      <p className="m-0 flex items-start gap-2.5 px-1 text-[13.5px] leading-[1.55] text-mute">
        <IconShield size={16} className="mt-0.5 shrink-0 text-ice" />
        <span>{rt('staking.risksBody', bold)}</span>
      </p>
    </>
  );
}

interface FlowSpec<B, S> {
  title: string;
  form?: ReactNode;
  canBuild?: boolean;
  build: () => Promise<B>;
  enClair: (b: B) => ReactNode;
  review: (b: B) => ReactNode;
  warnings: (b: B) => string[];
  sign: (b: B, password: string) => Promise<S>;
  broadcast: (s: S) => Promise<string>;
  doneText: string;
}

function errText(e: unknown): string {
  const err = toIpcError(e);
  return err.code === 'USER_REJECTED' ? tNow('staking.signCancelled') : err.message;
}

function StakeFlowDialog<B, S>({ spec, onClose, onDone }: { spec: FlowSpec<B, S>; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<'form' | 'review' | 'done'>(spec.form ? 'form' : 'review');
  const [built, setBuilt] = useState<B | null>(null);
  const [busy, setBusy] = useState<'build' | 'sign' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [password, setPassword] = useState('');
  const [txid, setTxid] = useState<string | null>(null);
  const { t } = useT();

  const build = async () => {
    setBusy('build');
    setError(null);
    try {
      setBuilt(await spec.build());
      setStep('review');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    if (!spec.form) void build();
  }, []);

  const sign = async () => {
    if (!built) return;
    setBusy('sign');
    setError(null);
    try {
      const signed = await spec.sign(built, password);
      setPassword('');
      setTxid(await spec.broadcast(signed));
      setStep('done');
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const warnings = built ? spec.warnings(built) : [];
  return (
    <Dialog open onOpenChange={(v) => (v || busy === 'sign' ? undefined : onClose())} title={spec.title} className="w-[620px]" dismissable={busy !== 'sign'}>
      {step === 'form' && (
        <>
          {spec.form}
          {error !== null && <ErrorLine error={error}>{errText(error)}</ErrorLine>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={spec.canBuild === false || busy !== null} onClick={() => void build()}>
              {busy === 'build' && <Spinner />} {t('staking.check')}
            </Button>
          </div>
        </>
      )}
      {step === 'review' && (
        <>
          {!built ? (
            error !== null ? (
              <ErrorLine error={error} onRetry={() => void build()}>
                {errText(error)}
              </ErrorLine>
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-mute">
                <Spinner /> {t('staking.building')}
              </div>
            )
          ) : (
            <>
              <EnClair>{spec.enClair(built)}</EnClair>
              <dl className="m-0 flex flex-col text-[13px]">{spec.review(built)}</dl>
              <SecondConfirmNotice lines={warnings} />
              <p className="m-0 text-[12px] leading-[1.5] text-mute">{t('staking.reviewNote')}</p>
              <PasswordField id="stake-password" value={password} onChange={setPassword} autoFocus onEnter={() => password && busy === null && void sign()} invalid={toIpcError(error).code === 'WRONG_PASSWORD'} />
              {error !== null && <ErrorLine error={error}>{errText(error)}</ErrorLine>}
              <div className="flex justify-end gap-2">
                {spec.form ? (
                  <Button disabled={busy !== null} onClick={() => (setStep('form'), setBuilt(null), setError(null))}>
                    {t('common.edit')}
                  </Button>
                ) : (
                  <Button disabled={busy !== null} onClick={onClose}>
                    {t('common.cancel')}
                  </Button>
                )}
                <Button variant="primary" disabled={!password || busy !== null} onClick={() => void sign()}>
                  {busy === 'sign' && <Spinner />} {t('staking.signAndBroadcast')}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {step === 'done' && txid && (
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <span className="dialog flex size-12 items-center justify-center rounded-full border border-up/40 text-up" data-state="open">
            <IconCheck size={22} />
          </span>
          <p className="m-0 text-[14px] leading-[1.6] text-text2">{spec.doneText}</p>
          <div className="flex w-full items-center justify-between gap-2 rounded-ctl border border-line bg-bg py-2 pr-2 pl-3.5">
            <span className="truncate font-mono text-[12px] text-text2">{txid}</span>
            <CopyButton text={txid} />
          </div>
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

function Row({ k, v, tone }: { k: string; v: ReactNode; tone?: 'warn' | 'up' }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line py-1.5">
      <dt className="shrink-0 text-mute">{k}</dt>
      <dd className={cn('m-0 min-w-0 text-right break-words', tone === 'warn' && 'text-warn', tone === 'up' && 'text-up')}>{v}</dd>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="eyebrow">{k}</span>
      <span className="figure truncate text-[20px]">{v}</span>
      {sub && <span className="text-[12px] text-faint">{sub}</span>}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-2 text-[12px] leading-[1.55] text-mute">
      <IconInfo size={14} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function AmountField({ id, label, value, onChange, unit, onMax, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; unit: { decimals: number; symbol: string }; onMax?: () => void; hint?: ReactNode }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="eyebrow">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <div className="flex h-11 flex-1 items-center rounded-ctl border border-line-2 bg-bg pr-3 pl-3.5 transition-colors hover:border-line-3 focus-within:border-ice-line">
          <input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(sanitizeDecimalInput(e.target.value, unit.decimals))} placeholder="0" className="min-w-0 flex-1 bg-transparent text-[15px]" />
          <span className="font-mono text-[12px] font-medium text-mute">{unit.symbol}</span>
        </div>
        {onMax && (
          <Button size="md" onClick={onMax}>
            {t('common.max')}
          </Button>
        )}
      </div>
      {hint && <span className="text-[12px] leading-[1.5] text-mute">{hint}</span>}
    </div>
  );
}

function EpochBar({ epoch, slotsInEpoch, slotSecs, secondsLeft, loadedAt, label }: { epoch: number; slotsInEpoch: number; slotSecs: number; secondsLeft: number; loadedAt: number | null; label: string }) {
  const now = useNow(1000);
  const { t } = useT();
  const left = Math.max(0, secondsLeft - (loadedAt ? (now - loadedAt) / 1000 : 0));
  const pct = Math.max(0, Math.min(100, (1 - left / (slotsInEpoch * slotSecs)) * 100));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium">
          {label} <span className="font-mono">{epoch}</span>
        </span>
        <span className="text-mute">{t('staking.endsIn', { duration: fmtDuration(left) })}</span>
      </div>
      <div className="h-[3px] overflow-hidden rounded-full bg-control-2" role="progressbar" aria-label={t('staking.epochProgress', { label: label.toLowerCase(), epoch })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="h-full rounded-full bg-ice transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SortBar<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  const { t } = useT();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="eyebrow">{label}</span>
      <Segmented size="sm" label={t('staking.sortBy')} value={value} onChange={onChange} options={options} />
    </div>
  );
}

function ValidatorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useAsync(() => call('sol_stake_validators', {}), []);
  const [sort, setSort] = useState<SolSort>('commission');
  const { t } = useT();
  const sorted = useMemo(() => sortValidators(list.data?.validators ?? [], sort), [list.data, sort]);
  return (
    <div className="flex flex-col gap-2">
      <SortBar label={t('staking.validator')} value={sort} onChange={setSort} options={[{ value: 'commission', label: t('staking.sortCommission') }, { value: 'stake', label: t('staking.sortActiveStake') }]} />
      {list.error ? (
        <ErrorLine error={list.error} onRetry={list.reload}>
          {list.error.message}
        </ErrorLine>
      ) : !list.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div role="radiogroup" aria-label={t('staking.validators')} className="flex max-h-[240px] flex-col overflow-y-auto rounded-ctl border border-line scroll-thin">
          {sorted.map((v) => (
            <ValidatorRow key={v.voteAccount} v={v} selected={v.voteAccount === value} onSelect={() => onChange(v.voteAccount)} />
          ))}
        </div>
      )}
      {list.data && !list.data.namesAvailable && <Hint>{t('staking.namesUnavailable')}</Hint>}
      <Hint>{t('staking.validatorHint')}</Hint>
    </div>
  );
}

function ValidatorRow({ v, selected, onSelect }: { v: SolValidator; selected: boolean; onSelect: () => void }) {
  const { t } = useT();
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className={cn('flex items-center gap-3 border-b border-line px-3 py-2 text-left text-[13px] last:border-b-0', selected ? 'bg-ice/[.07]' : 'hover:bg-raised')}>
      <span className={cn('size-3.5 shrink-0 rounded-full border-2 transition-colors duration-150', selected ? 'border-ice bg-ice shadow-[inset_0_0_0_2px_var(--color-bg)]' : 'border-line-3')} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">
          {v.name ?? t('staking.noName')} {v.name && <span className="font-normal text-faint">{t('staking.declared')}</span>}
        </span>
        <span className="truncate font-mono text-[12px] text-faint">{shortAddress(v.voteAccount, 8, 6)}</span>
      </span>
      <span className="flex shrink-0 flex-wrap justify-end gap-1">
        {solValidatorBadges(v).map((b) => (
          <Badge key={b.text} tone={b.tone}>
            {b.text}
          </Badge>
        ))}
      </span>
      <span className="w-16 shrink-0 text-right">{pc(v.commission)}</span>
      <span className="w-28 shrink-0 text-right text-mute">{fmtStake(v.activatedStake, 9, 'SOL')}</span>
    </button>
  );
}

type SolBuilt = Ret<'sol_stake_build'>;
type SolSigned = Ret<'sol_stake_sign'> & { message: string };
type SolOp = { kind: 'create' } | { kind: 'delegate'; acc: SolStakePosition } | { kind: 'deactivate'; acc: SolStakePosition } | { kind: 'withdraw'; acc: SolStakePosition };

function SolStaking() {
  const { network, hideBalances } = useApp();
  const acct = useStakeAccount();
  const ov = useAsync(() => call('sol_stake_overview', acct('sol')), [acct('sol').account], { intervalMs: 60_000 });
  const vals = useAsync(() => call('sol_stake_validators', {}), []);
  useOnTorReady(ov.reload);
  const [op, setOp] = useState<SolOp | null>(null);
  const { t, tp } = useT();
  const byVote = useMemo(() => new Map((vals.data?.validators ?? []).map((v) => [v.voteAccount, v])), [vals.data]);
  const o = ov.data;
  const h = (s: string) => (hideBalances ? HIDDEN : s);
  if (ov.error && !o) return <ErrorLine error={ov.error} onRetry={ov.reload}>{ov.error.message}</ErrorLine>;
  if (!o) return <Skeleton className="h-64 w-full" />;
  const total = o.accounts.reduce((s, a) => s + BigInt(a.lamports), 0n);
  return (
    <>
      <Card className="flex flex-col gap-4 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid flex-1 grid-cols-3 gap-6">
            <Stat k={t('staking.available')} v={h(amt(o.balance, SOL))} sub={t('staking.onYourAddress')} />
            <Stat k={t('staking.inStakeAccounts')} v={h(amt(total, SOL))} sub={tp('staking.accounts', o.accounts.length)} />
            <Stat k={t('staking.minDelegation')} v={amt(o.minimumDelegation, SOL)} sub={t('staking.rentReserve', { amount: amt(o.rentExemptReserve, SOL), network: networkLabel('sol', network) })} />
          </div>
          <Button variant="primary" size="lg" onClick={() => setOp({ kind: 'create' })}>
            {t('staking.stakeSol')}
          </Button>
        </div>
        <EpochBar label={t('staking.epoch')} epoch={o.epoch.epoch} slotsInEpoch={o.epoch.slotsInEpoch} slotSecs={0.4} secondsLeft={o.epoch.secondsLeft} loadedAt={ov.updatedAt} />
        <Hint>{t('staking.solHint', { noSlashing: t('staking.noSlashing') })}</Hint>
      </Card>

      <Card className="flex flex-col">
        <div className="flex h-[50px] items-center border-b border-line px-5 text-[15px] font-medium tracking-[-0.01em]">{t('staking.yourStakeAccounts')}</div>
        {o.accounts.length === 0 ? (
          <EmptyState title={t('staking.noStakeAccount')}>{t('staking.noStakeAccountBody')}</EmptyState>
        ) : (
          o.accounts.map((a) => {
            const v = a.voteAccount ? byVote.get(a.voteAccount) : undefined;
            const canDeactivate = a.state === 'active' || a.state === 'activating';
            const canDelegate = a.state === 'initialized' || a.state === 'inactive';
            const canWithdraw = BigInt(a.withdrawable) > 0n || a.canClose;
            return (
              <div key={a.address} className="flex items-center gap-4 border-b border-line px-5 py-3.5 text-[13px] last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <Badge tone={solStateTone(a.state)}>{solStateLabel(a.state)}</Badge>
                    <span className="truncate font-mono text-[12px] text-text2">{shortAddress(a.address, 8, 6)}</span>
                    {!a.ours && <Badge>{t('staking.readOnly')}</Badge>}
                  </span>
                  <span className="text-mute">
                    {a.voteAccount ? (
                      <>
                        {v?.name ?? shortAddress(a.voteAccount, 8, 6)}
                        {v?.name && t('staking.declaredSuffix')}
                        {v && t('staking.commissionSuffix', { pct: pc(v.commission) })}
                        {v?.delinquent && <span className="text-down">{t('staking.delinquentSuffix')}</span>}
                      </>
                    ) : (
                      t('staking.notDelegated')
                    )}
                    {a.state === 'activating' && a.activationEpoch !== null && t('staking.activeAtEpoch', { epoch: a.activationEpoch + 1 })}
                    {a.state === 'deactivating' && a.deactivationEpoch !== null && t('staking.withdrawableAtEpoch', { epoch: a.deactivationEpoch + 1 })}
                  </span>
                  {!a.ours && <span className="text-faint">{a.lockupInForce ? t('staking.lockupInForce') : t('staking.otherAuthorities')}</span>}
                </div>
                <div className="flex w-44 shrink-0 flex-col items-end">
                  <span className="font-semibold">{h(amt(a.lamports, SOL))}</span>
                  <span className="text-[12px] text-mute">
                    {a.state === 'activating' ? t('staking.activatingAmount', { amount: h(amt(a.activating, SOL)) }) : a.state === 'deactivating' ? t('staking.deactivatingAmount', { amount: h(amt(a.deactivating, SOL)) }) : t('staking.effectiveAmount', { amount: h(amt(a.effective, SOL)) })}
                  </span>
                  {BigInt(a.withdrawable) > 0n && <span className="text-[12px] text-faint">{t('staking.withdrawableAmount', { amount: h(amt(a.withdrawable, SOL)) })}</span>}
                </div>
                <div className="flex w-[240px] shrink-0 justify-end gap-2">
                  {a.ours && canDeactivate && (
                    <Button size="sm" onClick={() => setOp({ kind: 'deactivate', acc: a })}>
                      {t('staking.deactivate')}
                    </Button>
                  )}
                  {a.ours && canDelegate && (
                    <Button size="sm" onClick={() => setOp({ kind: 'delegate', acc: a })}>
                      {t('staking.delegate')}
                    </Button>
                  )}
                  {a.ours && canWithdraw && (
                    <Button size="sm" variant="ice" onClick={() => setOp({ kind: 'withdraw', acc: a })}>
                      {t('staking.withdraw')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </Card>
      {op && <SolOpDialog key={JSON.stringify(op.kind === 'create' ? op : { k: op.kind, a: op.acc.address })} op={op} o={o} onClose={() => setOp(null)} onDone={ov.reload} />}
    </>
  );
}

function SolOpDialog({ op, o, onClose, onDone }: { op: SolOp; o: SolStakeOverview; onClose: () => void; onDone: () => void }) {
  const { network } = useApp();
  const acct = useStakeAccount();
  const [amount, setAmount] = useState(op.kind === 'withdraw' ? toInputDecimal(BigInt(op.acc.canClose ? op.acc.lamports : op.acc.withdrawable), 9) : '');
  const [vote, setVote] = useState('');
  const lamports = tryParseUnits(amount, 9);
  const min = BigInt(o.minimumDelegation);
  const rent = BigInt(o.rentExemptReserve);
  const fee = 5000n;
  const maxCreate = BigInt(o.balance) - rent - fee;
  const { t } = useT();

  let title: string;
  let form: ReactNode | undefined;
  let canBuild = true;
  let action: Commands['sol_stake_build']['args']['action'];
  if (op.kind === 'create') {
    title = t('staking.stakeSol');
    canBuild = !!lamports && lamports >= min && !!vote;
    action = { kind: 'createAndDelegate', lamports: (lamports ?? 0n).toString(), voteAccount: vote };
    form = (
      <>
        <AmountField
          id="sol-stake-amount"
          label={t('staking.amountToDelegate')}
          value={amount}
          onChange={setAmount}
          unit={SOL}
          onMax={() => setAmount(toInputDecimal(maxCreate > 0n ? maxCreate : 0n, 9))}
          hint={
            <>
              {t(network === 'testnet' ? 'staking.solCreateHintDevnet' : 'staking.solCreateHint', { min: amt(min, SOL), rent: amt(rent, SOL), available: amt(o.balance, SOL) })}
              {lamports !== null && lamports > 0n && lamports < min && <span className="text-warn">{t('staking.belowMinimum')}</span>}
            </>
          }
        />
        <ValidatorPicker value={vote} onChange={setVote} />
      </>
    );
  } else if (op.kind === 'delegate') {
    title = t('staking.delegateTitle');
    canBuild = !!vote;
    action = { kind: 'delegate', stakeAccount: op.acc.address, voteAccount: vote };
    form = <ValidatorPicker value={vote} onChange={setVote} />;
  } else if (op.kind === 'deactivate') {
    title = t('staking.deactivateTitle');
    action = { kind: 'deactivate', stakeAccount: op.acc.address };
  } else {
    title = t('staking.withdrawSolTitle');
    const max = BigInt(op.acc.canClose ? op.acc.lamports : op.acc.withdrawable);
    canBuild = !!lamports && lamports > 0n && lamports <= max;
    action = { kind: 'withdraw', stakeAccount: op.acc.address, lamports: (lamports ?? 0n).toString() };
    form = (
      <AmountField
        id="sol-withdraw-amount"
        label={t('staking.amountToWithdraw')}
        value={amount}
        onChange={setAmount}
        unit={SOL}
        onMax={() => setAmount(toInputDecimal(max, 9))}
        hint={op.acc.canClose ? t('staking.withdrawAllCloses') : t('staking.withdrawPartial', { amount: amt(max, SOL) })}
      />
    );
  }

  const spec: FlowSpec<SolBuilt & { message: string }, SolSigned> = {
    title,
    ...(form ? { form } : {}),
    canBuild,
    build: () => call('sol_stake_build', { action, ...acct('sol') }),
    enClair: (b) => {
      const s = b.stake;
      const v = s.validator ? t('staking.validatorWithCommission', { name: s.validator.name ?? shortAddress(s.validator.voteAccount), pct: pc(s.validator.commission) }) : '';
      if (s.kind === 'createAndDelegate') return t('staking.plainSolCreate', { amount: amt(s.lamports, SOL), rent: amt(s.rentExemptReserve, SOL), delegated: amt(s.delegated, SOL), validator: v, epoch: s.epoch.epoch + 1 });
      if (s.kind === 'delegate') return t('staking.plainSolDelegate', { validator: v, epoch: s.epoch.epoch + 1 });
      if (s.kind === 'deactivate') return t('staking.plainSolDeactivate', { epoch: s.epoch.epoch, duration: fmtDuration(s.epoch.secondsLeft) });
      return t(s.closesAccount ? 'staking.plainSolWithdrawClose' : 'staking.plainSolWithdraw', { amount: amt(s.lamports, SOL) });
    },
    review: (b) => {
      const s = b.stake;
      return (
        <>
          <Row k={t('staking.rowStakeAccount')} v={<span className="font-mono text-[12px]">{shortAddress(s.stakeAccount, 10, 8)}</span>} />
          {s.kind === 'createAndDelegate' && <Row k={t('staking.rowPaidIn')} v={t('staking.rowPaidInValue', { amount: amt(s.lamports, SOL), delegated: amt(s.delegated, SOL), rent: amt(s.rentExemptReserve, SOL) })} />}
          {s.kind === 'delegate' && <Row k={t('staking.rowDelegated')} v={amt(s.delegated, SOL)} />}
          {s.kind === 'deactivate' && <Row k={t('staking.rowDelegatedNow')} v={amt(s.delegated, SOL)} />}
          {s.kind === 'withdraw' && <Row k={t('staking.rowWithdrawn')} v={`${amt(s.lamports, SOL)}${s.closesAccount ? t('staking.closesAccountSuffix') : ''}`} />}
          {s.validator && (
            <Row
              k={t('staking.validator')}
              v={
                <span className="flex flex-col items-end">
                  <span>
                    {s.validator.name ?? t('staking.noName')} {s.validator.name && <span className="text-faint">{t('staking.declared')}</span>}{t('staking.validatorCommission', { pct: pc(s.validator.commission) })}
                    {s.validator.delinquent && <span className="text-down">{t('staking.delinquentSuffix')}</span>}
                  </span>
                  <span className="font-mono text-[12px] text-faint">{t('staking.validatorVote', { vote: shortAddress(s.validator.voteAccount, 8, 6), stake: fmtStake(s.validator.activatedStake, 9, 'SOL') })}</span>
                </span>
              }
              {...(s.warnings.length ? { tone: 'warn' as const } : {})}
            />
          )}
          <Row k={t('staking.epoch')} v={t('staking.epochEndsIn', { epoch: s.epoch.epoch, duration: fmtDuration(s.epoch.secondsLeft) })} />
          <Row k={t('staking.rowInstructions')} v={b.summary.instructions.map(instructionLabel).join(' · ')} />
          <Row k={t('staking.rowAuthorities')} v={t('staking.rowAuthoritiesValue')} />
          <Row k={t('staking.rowNetworkFee')} v={amt(s.fee, SOL)} />
          <Row k={t('staking.rowRisk')} v={t('staking.riskSol')} />
        </>
      );
    },
    warnings: (b) => b.stake.warnings.map(solWarningText),
    sign: async (b, password) => ({ ...(await call('sol_stake_sign', { message: b.message, password, ...acct('sol') })), message: b.message }),
    broadcast: (s) => call('sol_stake_broadcast', { message: s.message, signature: s.signature, ...acct('sol') }),
    doneText: t('staking.doneSol'),
  };
  return <StakeFlowDialog spec={spec} onClose={onClose} onDone={onDone} />;
}

function DrepChoice({ mode, onMode, custom, onCustom, keepCurrent }: { mode: DrepMode | 'keep'; onMode: (m: DrepMode | 'keep') => void; custom: string; onCustom: (v: string) => void; keepCurrent: string | null }) {
  const { t } = useT();
  const opts: { value: DrepMode | 'keep'; title: string; text: string }[] = [
    ...(keepCurrent ? [{ value: 'keep' as const, title: t('staking.drepKeep', { label: drepLabel(keepCurrent) }), text: t('staking.drepKeepText') }] : []),
    { value: 'alwaysAbstain', title: t('staking.drepAbstainSuggested'), text: t('staking.drepAbstainText') },
    { value: 'alwaysNoConfidence', title: t('staking.drepNoConfidence'), text: t('staking.drepNoConfidenceText') },
    { value: 'custom', title: t('staking.drepCustom'), text: t('staking.drepCustomText') },
  ];
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="pb-1 text-[12px] font-medium text-mute">{t('staking.drepLegend')}</legend>
      <p className="m-0 text-[12px] leading-[1.55] text-mute">{rt('staking.drepExplain', bold2)}</p>
      {opts.map((o) => (
        <label key={o.value} className={cn('flex cursor-pointer items-start gap-3 rounded-ctl border px-3 py-2.5 text-[13px]', mode === o.value ? 'border-ice/50 bg-ice/[.06]' : 'border-line hover:bg-raised')}>
          <input type="radio" name="drep" className="mt-1 accent-[#7CC4FF]" checked={mode === o.value} onChange={() => onMode(o.value)} />
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold">{o.title}</span>
            <span className="text-[12px] leading-[1.5] text-mute">{o.text}</span>
          </span>
        </label>
      ))}
      {mode === 'custom' && <Input aria-label={t('staking.drepIdLabel')} placeholder="drep1…" value={custom} onChange={(e) => onCustom(e.target.value)} className="font-mono text-[13px]" />}
      {mode === 'custom' && custom.trim() !== '' && drepArg('custom', custom) === null && <span className="text-[12px] text-warn">{t('staking.drepIdExpected')}</span>}
    </fieldset>
  );
}

function PoolPicker({ value, onChange }: { value: string; onChange: (id: string, pool: AdaPool | null) => void }) {
  const list = useAsync(() => call('ada_stake_pools', { limit: 50 }), []);
  const [sort, setSort] = useState<AdaSort>('margin');
  const [typed, setTyped] = useState('');
  const { t } = useT();
  const [lookup, setLookup] = useState<{ pool: AdaPool | null; error: unknown; busy: boolean }>({ pool: null, error: null, busy: false });
  const sorted = useMemo(() => sortPools(list.data ?? [], sort), [list.data, sort]);
  const find = async () => {
    setLookup({ pool: null, error: null, busy: true });
    try {
      const pool = await call('ada_stake_pool', { poolId: typed.trim() });
      setLookup({ pool, error: null, busy: false });
      onChange(pool.poolId, pool);
    } catch (e) {
      setLookup({ pool: null, error: e, busy: false });
    }
  };
  const rows = lookup.pool && !sorted.some((p) => p.poolId === lookup.pool?.poolId) ? [lookup.pool, ...sorted] : sorted;
  return (
    <div className="flex flex-col gap-2">
      <SortBar
        label={t('staking.pool')}
        value={sort}
        onChange={setSort}
        options={[
          { value: 'margin', label: t('staking.sortMargin') },
          { value: 'saturation', label: t('staking.sortSaturation') },
          { value: 'stake', label: t('staking.sortStake') },
        ]}
      />
      {list.error ? (
        <ErrorLine error={list.error} onRetry={list.reload}>
          {list.error.message}
        </ErrorLine>
      ) : !list.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div role="radiogroup" aria-label={t('staking.pools')} className="flex max-h-[220px] flex-col overflow-y-auto rounded-ctl border border-line scroll-thin">
          {rows.map((p) => {
            const selected = p.poolId === value;
            return (
              <button key={p.poolId} type="button" role="radio" aria-checked={selected} onClick={() => onChange(p.poolId, p)} className={cn('flex items-center gap-3 border-b border-line px-3 py-2 text-left text-[13px] last:border-b-0', selected ? 'bg-ice/10' : 'hover:bg-raised')}>
                <span className={cn('size-3.5 shrink-0 rounded-full border-2 transition-colors duration-150', selected ? 'border-ice bg-ice shadow-[inset_0_0_0_2px_var(--color-bg)]' : 'border-line-3')} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold">
                    {p.ticker ?? '—'} <span className="font-normal text-text2">{p.name ?? ''}</span> <span className="font-normal text-faint">{t('staking.declared')}</span>
                  </span>
                  <span className="truncate text-[12px] text-faint">{t('staking.poolCost', { cost: amt(p.fixedCost, ADA), delegators: p.liveDelegators ?? '—' })}</span>
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {adaPoolBadges(p).map((b) => (
                    <Badge key={b.text} tone={b.tone}>
                      {b.text}
                    </Badge>
                  ))}
                </span>
                <span className="w-14 shrink-0 text-right">{pc(p.margin * 100, 1)}</span>
                <span className="w-16 shrink-0 text-right text-mute">{p.liveSaturation !== null ? pc(p.liveSaturation, 1) : '—'}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex gap-2">
        <Input aria-label={t('staking.poolIdLabel')} placeholder={t('staking.poolIdPlaceholder')} value={typed} onChange={(e) => setTyped(e.target.value)} className="h-10 font-mono text-[12px]" />
        <Button disabled={!typed.trim() || lookup.busy} onClick={() => void find()}>
          {lookup.busy && <Spinner />} {t('staking.search')}
        </Button>
      </div>
      {lookup.error !== null && <ErrorLine error={lookup.error}>{toIpcError(lookup.error).message}</ErrorLine>}
      <Hint>{t('staking.poolHint')}</Hint>
    </div>
  );
}

type AdaBuilt = Ret<'ada_stake_build'>;
type AdaSigned = Ret<'ada_stake_sign'>;
type AdaOp = 'delegate' | 'vote' | 'withdraw' | 'deregister';

function AdaStaking() {
  const { hideBalances, network } = useApp();
  const acct = useStakeAccount();
  const ov = useAsync(() => call('ada_stake_overview', acct('ada')), [acct('ada').account], { intervalMs: 60_000 });
  useOnTorReady(ov.reload);
  const [op, setOp] = useState<AdaOp | null>(null);
  const { t } = useT();
  const o = ov.data;
  const h = (s: string) => (hideBalances ? HIDDEN : s);
  if (ov.error && !o) return <ErrorLine error={ov.error} onRetry={ov.reload}>{ov.error.message}</ErrorLine>;
  if (!o) return <Skeleton className="h-64 w-full" />;
  const s = o.stake;
  const rewards = BigInt(s.rewardsAvailable);
  return (
    <>
      <Card className="flex flex-col gap-4 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid flex-1 grid-cols-3 gap-6">
            <Stat k={t('staking.adaDelegated')} v={h(amt(s.totalBalance, ADA))} sub={t('staking.adaDelegatedSub')} />
            <Stat k={t('staking.adaRewards')} v={h(amt(s.rewardsAvailable, ADA))} sub={t('staking.adaRewardsSub')} />
            <Stat k={t('staking.adaDeposit')} v={s.registered ? amt(s.deposit, ADA) : t('staking.none')} sub={s.registered ? t('staking.adaDepositBack') : t('staking.adaDepositFirst', { amount: amt(o.keyDeposit, ADA) })} />
          </div>
          <Button variant="primary" size="lg" onClick={() => setOp('delegate')}>
            {s.registered && s.delegatedPool ? t('staking.changePool') : t('staking.delegate')}
          </Button>
        </div>
        <EpochBar label={t('staking.epoch')} epoch={o.epoch.epoch} slotsInEpoch={o.epoch.epochLength} slotSecs={1} secondsLeft={o.epoch.secondsLeft} loadedAt={ov.updatedAt} />
        <Hint>{t('staking.adaHint', { noSlashing: t('staking.noSlashing') })}</Hint>
      </Card>

      <Card className="flex flex-col">
        <div className="flex h-[50px] items-center justify-between border-b border-line px-5">
          <span className="text-[15px] font-medium tracking-[-0.01em]">{t('staking.yourDelegation', { network: networkLabel('ada', network) })}</span>
          <span className="font-mono text-[12px] text-faint">{shortAddress(s.stakeAddress, 12, 6)}</span>
        </div>
        <dl className="m-0 flex flex-col px-5 py-1 text-[13px]">
          <Row k={t('staking.stakeKey')} v={s.registered ? <Badge tone="up">{t('staking.registered')}</Badge> : <Badge>{t('staking.notRegistered')}</Badge>} />
          <Row
            k={t('staking.pool')}
            v={
              o.pool ? (
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  <span>
                    {rt('staking.poolLine', {}, { ticker: o.pool.ticker, name: o.pool.name, declared: <span className="text-faint">{t('staking.declared')}</span>, margin: pc(o.pool.margin * 100, 1), saturation: o.pool.liveSaturation !== null ? pc(o.pool.liveSaturation, 1) : '—' })}
                  </span>
                  {adaPoolBadges(o.pool).map((b) => (
                    <Badge key={b.text} tone={b.tone}>
                      {b.text}
                    </Badge>
                  ))}
                </span>
              ) : s.delegatedPool ? (
                shortAddress(s.delegatedPool, 10, 6)
              ) : (
                t('staking.none')
              )
            }
          />
          <Row k={t('staking.voteDrep')} v={drepLabel(s.delegatedDrep)} {...(s.registered && !s.delegatedDrep ? { tone: 'warn' as const } : {})} />
        </dl>
        {s.registered && rewards > 0n && !o.canWithdraw && (
          <Notice tone="warn" className="mx-5 mb-3" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            {rt('staking.adaNeedVote', bold)}{' '}
            <button type="button" className="font-semibold text-ice hover:underline" onClick={() => setOp('vote')}>
              {t('staking.delegateMyVote')}
            </button>
          </Notice>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
          <Button size="sm" onClick={() => setOp('vote')}>
            {s.delegatedDrep ? t('staking.changeMyVote') : t('staking.delegateMyVote')}
          </Button>
          <Button size="sm" variant="ice" disabled={!o.canWithdraw} title={o.canWithdraw ? undefined : rewards === 0n ? t('staking.noRewardToWithdraw') : t('staking.delegateVoteFirst')} onClick={() => setOp('withdraw')}>
            {t('staking.withdrawRewards')}
          </Button>
          <Button size="sm" variant="dangerOutline" disabled={!s.registered} onClick={() => setOp('deregister')}>
            {t('staking.stopStaking')}
          </Button>
        </div>
      </Card>
      {op && <AdaOpDialog key={op} op={op} o={o} onClose={() => setOp(null)} onDone={ov.reload} />}
    </>
  );
}

function AdaOpDialog({ op, o, onClose, onDone }: { op: AdaOp; o: AdaStakeOverview; onClose: () => void; onDone: () => void }) {
  const acct = useStakeAccount();
  const current = o.stake.delegatedDrep;
  const [poolId, setPoolId] = useState('');
  const [mode, setMode] = useState<DrepMode | 'keep'>(op === 'delegate' && current ? 'keep' : 'alwaysAbstain');
  const [custom, setCustom] = useState('');
  const drep = mode === 'keep' ? null : drepArg(mode, custom);
  const drepOk = mode === 'keep' || drep !== null;
  const { t } = useT();

  let title: string;
  let form: ReactNode | undefined;
  let canBuild = true;
  let action: Commands['ada_stake_build']['args']['action'];
  if (op === 'delegate') {
    title = o.stake.delegatedPool ? t('staking.changePool') : t('staking.delegateToPool');
    canBuild = !!poolId && drepOk;
    action = { kind: 'delegate', poolId, ...(drep ? { drep } : {}) };
    form = (
      <>
        {!o.stake.registered && (
          <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
            {rt('staking.adaFirstDelegation', bold, { amount: amt(o.keyDeposit, ADA) })}
          </Notice>
        )}
        <PoolPicker value={poolId} onChange={(id) => setPoolId(id)} />
        <DrepChoice mode={mode} onMode={setMode} custom={custom} onCustom={setCustom} keepCurrent={current} />
      </>
    );
  } else if (op === 'vote') {
    title = t('staking.voteDelegationTitle');
    canBuild = drep !== null;
    action = { kind: 'voteDelegate', drep: drep ?? 'alwaysAbstain' };
    form = (
      <>
        {!o.stake.registered && <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>{t('staking.adaKeyNotRegistered', { amount: amt(o.keyDeposit, ADA) })}</Notice>}
        <DrepChoice mode={mode === 'keep' ? 'alwaysAbstain' : mode} onMode={setMode} custom={custom} onCustom={setCustom} keepCurrent={null} />
      </>
    );
  } else if (op === 'withdraw') {
    title = t('staking.withdrawRewards');
    action = { kind: 'withdraw' };
  } else {
    title = t('staking.stopStaking');
    action = { kind: 'deregister' };
  }

  const spec: FlowSpec<AdaBuilt, AdaSigned> = {
    title,
    ...(form ? { form } : {}),
    canBuild,
    build: () => call('ada_stake_build', { action, ...acct('ada') }),
    enClair: (b) => {
      const s = b.summary;
      const parts: string[] = [];
      for (const c of s.certificates) {
        if (c.type === 'stakeRegistration') parts.push(t('staking.plainAdaRegister', { amount: amt(c.deposit, ADA) }));
        if (c.type === 'stakeDelegation') parts.push(t('staking.plainAdaDelegate', { pool: b.context.pool?.ticker ?? shortAddress(c.poolId) }));
        if (c.type === 'voteDelegation') parts.push(t('staking.plainAdaVote', { drep: c.drep.kind === 'alwaysAbstain' ? t('staking.plainAdaAbstain') : c.drep.kind === 'alwaysNoConfidence' ? t('staking.plainAdaNoConfidence') : shortAddress(c.drep.id, 10, 6) }));
        if (c.type === 'stakeDeregistration') parts.push(t('staking.plainAdaDeregister', { amount: amt(c.refund, ADA) }));
      }
      if (BigInt(s.withdrawn) > 0n) parts.push(t('staking.plainAdaWithdraw', { amount: amt(s.withdrawn, ADA) }));
      const net = BigInt(b.context.netCost);
      const txt = parts.join(', ');
      return t('staking.plainAdaSentence', { parts: `${txt.charAt(0).toUpperCase()}${txt.slice(1)}`, net: net >= 0n ? t('staking.netCostValue', { amount: amt(net, ADA) }) : t('staking.netGainValue', { amount: amt(-net, ADA) }) });
    },
    review: (b) => {
      const s = b.summary;
      const c = b.context;
      return (
        <>
          {c.pool && (
            <Row
              k={t('staking.pool')}
              v={t('staking.poolReview', { ticker: c.pool.ticker ?? '—', name: c.pool.name ?? '', margin: pc(c.pool.margin * 100, 1), cost: amt(c.pool.fixedCost, ADA), pledge: amt(c.pool.pledge, ADA), saturation: c.pool.liveSaturation !== null ? pc(c.pool.liveSaturation, 1) : '—' })}
              {...(c.warnings.some((w) => w.kind !== 'drepInactive') ? { tone: 'warn' as const } : {})}
            />
          )}
          {c.drep && <Row k={t('staking.voteDrep')} v={`${c.drep.drep.kind === 'alwaysAbstain' ? t('staking.drepAbstain') : c.drep.drep.kind === 'alwaysNoConfidence' ? t('staking.drepNoConfidence') : shortAddress(c.drep.drep.id, 10, 6)}${c.drep.active ? '' : t('staking.inactiveSuffix')}`} {...(c.drep.active ? {} : { tone: 'warn' as const })} />}
          {BigInt(s.deposit) > 0n && <Row k={t('staking.rowDeposit')} v={t('staking.depositBack', { amount: amt(s.deposit, ADA) })} />}
          {BigInt(s.refund) > 0n && <Row k={t('staking.rowRefund')} v={amt(s.refund, ADA)} tone="up" />}
          {BigInt(s.withdrawn) > 0n && <Row k={t('staking.rowRewardsWithdrawn')} v={amt(s.withdrawn, ADA)} tone="up" />}
          <Row k={t('staking.rowNetworkFee')} v={amt(s.tx.fee, ADA)} />
          <Row k={BigInt(c.netCost) >= 0n ? t('staking.netCost') : t('staking.netGain')} v={amt(BigInt(c.netCost) >= 0n ? c.netCost : -BigInt(c.netCost), ADA)} />
          <Row k={t('staking.rowOutput')} v={t('staking.rowOutputValue')} />
          <Row k={t('staking.rowSchedule')} v={t('staking.scheduleValue', { epoch: c.epoch.epoch, counts: c.epoch.epoch + 2, rewards: c.epoch.epoch + 4 })} />
          <Row k={t('staking.rowRisk')} v={t('staking.riskAda')} />
        </>
      );
    },
    warnings: (b) => b.context.warnings.map(adaWarningText),
    sign: (b, password) => call('ada_stake_sign', { tx: b.tx, password, ...acct('ada') }),
    broadcast: (s) => call('ada_stake_broadcast', { tx: s.tx, ...acct('ada') }),
    doneText: t('staking.doneAda'),
  };
  return <StakeFlowDialog spec={spec} onClose={onClose} onDone={onDone} />;
}

type TronBuilt = Ret<'tron_stake_build'>;
type TronSigned = Ret<'tron_stake_sign'> & { raw: string };
type TronOp = 'freeze' | 'unfreeze' | 'vote' | 'withdraw' | 'cancel' | 'claim';

function TronStaking() {
  const { hideBalances, network } = useApp();
  const acct = useStakeAccount();
  const ov = useAsync(() => call('tron_stake_overview', acct('tron')), [acct('tron').account], { intervalMs: 60_000 });
  const ws = useAsync(() => call('tron_stake_witnesses'), []);
  useOnTorReady(ov.reload);
  const now = useNow(1000);
  const { t, tp } = useT();
  const [op, setOp] = useState<TronOp | null>(null);
  const a = ov.data;
  const h = (s: string) => (hideBalances ? HIDDEN : s);
  if (ov.error && !a) return <ErrorLine error={ov.error} onRetry={ov.reload}>{ov.error.message}</ErrorLine>;
  if (!a) return <Skeleton className="h-64 w-full" />;
  const byAddr = new Map((ws.data ?? []).map((w) => [w.address, w]));
  const claimable = BigInt(a.reward) > 0n && (a.nextClaimTime === 0 || a.nextClaimTime <= now);
  return (
    <>
      <Card className="flex flex-col gap-4 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid flex-1 grid-cols-4 gap-6">
            <Stat k={t('staking.available')} v={h(amt(a.balance, TRX))} />
            <Stat k={t('staking.stakedEnergy')} v={h(amt(a.stakedEnergy, TRX))} sub={t('staking.energyLeft', { left: a.energyLimit - a.energyUsed, limit: a.energyLimit })} />
            <Stat k={t('staking.stakedBandwidth')} v={h(amt(a.stakedBandwidth, TRX))} sub={t('staking.bandwidthLeft', { left: a.bandwidthLimit - a.bandwidthUsed, limit: a.bandwidthLimit })} />
            <Stat k={t('staking.tronPowerVoted')} v={`${a.tronPowerUsed} / ${a.tronPowerLimit}`} sub={t('staking.oneTrxOneVote')} />
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            <Button variant="primary" size="lg" onClick={() => setOp('freeze')}>
              {t('staking.stakeTrx')}
            </Button>
            <Button size="md" disabled={BigInt(a.stakedEnergy) + BigInt(a.stakedBandwidth) === 0n} onClick={() => setOp('unfreeze')}>
              {t('staking.unfreeze')}
            </Button>
          </div>
        </div>
        <Hint>{t(network === 'testnet' ? 'staking.tronHintTestnet' : 'staking.tronHint', { days: tp('time.days', a.unfreezeDelayDays), noSlashing: t('staking.noSlashing') })}</Hint>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card className="flex flex-col">
          <div className="flex h-[50px] items-center justify-between border-b border-line px-5">
            <span className="text-[15px] font-medium tracking-[-0.01em]">{t('staking.yourVotes')}</span>
            <Button size="sm" disabled={a.tronPowerLimit === 0} onClick={() => setOp('vote')}>
              {t('staking.vote')}
            </Button>
          </div>
          {a.votes.length === 0 ? (
            <EmptyState title={t('staking.noVote')}>{a.tronPowerLimit > 0 ? t('staking.noVoteHasPower') : t('staking.noVoteNoPower')}</EmptyState>
          ) : (
            a.votes.map((v) => {
              const w = byAddr.get(v.address);
              return (
                <div key={v.address} className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 text-[13px] last:border-b-0">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">
                      {w?.url ?? shortAddress(v.address)} <span className="font-normal text-faint">{t('staking.declared')}</span>
                    </span>
                    <span className="text-[12px] text-faint">{w ? t('staking.rank', { rank: w.rank }) : shortAddress(v.address)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {w && tronWitnessBadges(w).filter((b) => b.tone === 'down').map((b) => <Badge key={b.text} tone={b.tone}>{b.text}</Badge>)}
                    <span className="font-semibold">{t('staking.votesCount', { count: v.count })}</span>
                  </span>
                </div>
              );
            })
          )}
          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-[13px]">
            <span className="flex flex-col">
              <span className="text-mute">{t('staking.voteRewards')}</span>
              <span className="font-semibold">{h(amt(a.reward, TRX))}</span>
              {a.nextClaimTime > now && <span className="text-[12px] text-faint">{t('staking.claimableIn', { duration: fmtDuration((a.nextClaimTime - now) / 1000) })}</span>}
            </span>
            <Button size="sm" variant="ice" disabled={!claimable} title={claimable ? undefined : BigInt(a.reward) === 0n ? t('staking.noReward') : t('staking.oneClaimPer24h')} onClick={() => setOp('claim')}>
              {t('staking.claim')}
            </Button>
          </div>
        </Card>

        <Card className="flex flex-col">
          <div className="flex h-[50px] items-center justify-between border-b border-line px-5">
            <span className="text-[15px] font-medium tracking-[-0.01em]">{t('staking.pendingUnfreezes')}</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={a.unfreezing.length === 0} onClick={() => setOp('cancel')}>
                {t('staking.cancelUnfreezes')}
              </Button>
              <Button size="sm" variant="ice" disabled={BigInt(a.withdrawableNow) === 0n} onClick={() => setOp('withdraw')}>
                {BigInt(a.withdrawableNow) > 0n ? t('staking.withdrawAmount', { amount: h(amt(a.withdrawableNow, TRX)) }) : t('staking.withdraw')}
              </Button>
            </div>
          </div>
          {a.unfreezing.length === 0 ? (
            <EmptyState title={t('staking.noUnfreeze')}>{t('staking.noUnfreezeBody')}</EmptyState>
          ) : (
            a.unfreezing.map((u, i) => (
              <div key={`${u.expireTime}-${i}`} className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 text-[13px] last:border-b-0">
                <span className="flex flex-col">
                  <span className="font-semibold">{h(amt(u.amount, TRX))}</span>
                  <span className="text-[12px] text-faint">{u.resource === 'ENERGY' ? t('staking.energy') : t('staking.bandwidth')}</span>
                </span>
                {u.expireTime <= now ? <Badge tone="up">{t('staking.withdrawable')}</Badge> : <span className="text-mute">{t('staking.availableOn', { when: getLanguage() === 'fr' ? fmtWhen(u.expireTime, now).toLowerCase() : fmtWhen(u.expireTime, now), duration: fmtDuration((u.expireTime - now) / 1000) })}</span>}
              </div>
            ))
          )}
        </Card>
      </div>
      {op && <TronOpDialog key={op} op={op} a={a} witnesses={ws.data ?? []} onClose={() => setOp(null)} onDone={ov.reload} />}
    </>
  );
}

function VoteEditor({ witnesses, counts, onCounts, power }: { witnesses: TronWitness[]; counts: Record<string, string>; onCounts: (c: Record<string, string>) => void; power: number }) {
  const [sort, setSort] = useState<TronSort>('rank');
  const sorted = useMemo(() => sortWitnesses(witnesses, sort), [witnesses, sort]);
  const parsed = tronVotes(counts);
  const total = parsed?.total ?? 0;
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2">
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
        <strong className="font-semibold text-text">{t('staking.replaceVotesTitle')}</strong> {t('staking.replaceVotesBody')}
      </Notice>
      <SortBar label="Super Representatives" value={sort} onChange={setSort} options={[{ value: 'rank', label: t('staking.sortRank') }, { value: 'votes', label: t('staking.sortVotes') }]} />
      <div className="flex max-h-[260px] flex-col overflow-y-auto rounded-ctl border border-line scroll-thin">
        {sorted.map((w) => (
          <div key={w.address} className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[13px] last:border-b-0">
            <span className="w-9 shrink-0 text-right text-mute">#{w.rank}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-semibold">
                {w.url} <span className="font-normal text-faint">{t('staking.declared')}</span>
              </span>
              <span className="truncate text-[12px] text-faint">{t('staking.witnessVotes', { votes: fmtNumber(w.voteCount, 0) })}</span>
            </span>
            <span className="flex shrink-0 gap-1">
              {tronWitnessBadges(w).map((b) => (
                <Badge key={b.text} tone={b.tone}>
                  {b.text}
                </Badge>
              ))}
            </span>
            <input
              aria-label={t('staking.votesFor', { sr: w.url })}
              inputMode="numeric"
              value={counts[w.address] ?? ''}
              onChange={(e) => onCounts({ ...counts, [w.address]: e.target.value.replace(/\D/g, '') })}
              placeholder="0"
              className="h-8 w-20 shrink-0 rounded-[8px] border border-line-2 bg-bg px-2 text-right text-[13px] focus:border-ice-line"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-mute">{t('staking.srCount', { count: parsed?.votes.length ?? 0 })}</span>
        <span className={cn('font-semibold', total > power && 'text-down')}>
          {total} / {power} TRON Power
        </span>
      </div>
      <Hint>{t('staking.voteHint')}</Hint>
    </div>
  );
}

function TronOpDialog({ op, a, witnesses, onClose, onDone }: { op: TronOp; a: TronStakeAccount; witnesses: TronWitness[]; onClose: () => void; onDone: () => void }) {
  const acct = useStakeAccount();
  const [resource, setResource] = useState<TronResource>('ENERGY');
  const [amount, setAmount] = useState('');
  const [counts, setCounts] = useState<Record<string, string>>(() => Object.fromEntries(a.votes.map((v) => [v.address, v.count])));
  const sun = tryParseUnits(amount, 6);
  const staked = BigInt(resource === 'ENERGY' ? a.stakedEnergy : a.stakedBandwidth);
  const { t, tp } = useT();

  let title: string;
  let form: ReactNode | undefined;
  let canBuild = true;
  let action: Commands['tron_stake_build']['args']['action'];
  const resPicker = <Segmented label={t('staking.resource')} value={resource} onChange={setResource} options={[{ value: 'ENERGY', label: t('staking.energyCap') }, { value: 'BANDWIDTH', label: t('staking.bandwidthCap') }]} />;
  if (op === 'freeze') {
    title = t('staking.stakeTrx');
    canBuild = !!sun && sun >= 1_000_000n && sun <= BigInt(a.balance);
    action = { kind: 'freeze', resource, amount: (sun ?? 0n).toString() };
    form = (
      <>
        {resPicker}
        <AmountField id="tron-freeze" label={t('staking.amountToStake')} value={amount} onChange={setAmount} unit={TRX} onMax={() => setAmount(toInputDecimal(BigInt(a.balance), 6))} hint={t('staking.freezeHint', { available: amt(a.balance, TRX), days: tp('time.days', a.unfreezeDelayDays) })} />
      </>
    );
  } else if (op === 'unfreeze') {
    title = t('staking.unfreezeTitle');
    canBuild = !!sun && sun > 0n && sun <= staked;
    action = { kind: 'unfreeze', resource, amount: (sun ?? 0n).toString() };
    form = (
      <>
        {resPicker}
        <AmountField id="tron-unfreeze" label={t('staking.amountToUnfreeze')} value={amount} onChange={setAmount} unit={TRX} onMax={() => setAmount(toInputDecimal(staked, 6))} hint={t('staking.unfreezeHint', { staked: amt(staked, TRX), days: tp('time.days', a.unfreezeDelayDays) })} />
      </>
    );
  } else if (op === 'vote') {
    title = t('staking.voteTitle');
    const parsed = tronVotes(counts);
    canBuild = !!parsed && parsed.votes.length >= 1 && parsed.votes.length <= 30 && parsed.total <= a.tronPowerLimit;
    action = { kind: 'vote', votes: parsed?.votes ?? [] };
    form = <VoteEditor witnesses={witnesses} counts={counts} onCounts={setCounts} power={a.tronPowerLimit} />;
  } else if (op === 'withdraw') {
    title = t('staking.withdrawTrxTitle');
    action = { kind: 'withdrawUnfrozen' };
  } else if (op === 'cancel') {
    title = t('staking.cancelUnfreezes');
    action = { kind: 'cancelAllUnfreeze' };
  } else {
    title = t('staking.claimTitle');
    action = { kind: 'claimRewards' };
  }

  const spec: FlowSpec<TronBuilt, TronSigned> = {
    title,
    ...(form ? { form } : {}),
    canBuild,
    build: () => call('tron_stake_build', { action, ...acct('tron') }),
    enClair: (b) => {
      const x = b.summary.action;
      const c = b.context.account;
      switch (x.type) {
        case 'freeze':
          return t(x.resource === 'ENERGY' ? 'staking.plainTronFreezeEnergy' : 'staking.plainTronFreezeBandwidth', { amount: amt(x.amount, TRX), power: Number(BigInt(x.amount) / 1_000_000n), days: tp('time.days', c.unfreezeDelayDays) });
        case 'unfreeze':
          return t('staking.plainTronUnfreeze', { amount: amt(x.amount, TRX), resource: x.resource === 'ENERGY' ? t('staking.energy') : t('staking.bandwidth'), days: tp('time.days', c.unfreezeDelayDays) });
        case 'withdrawUnfrozen':
          return t('staking.plainTronWithdraw', { amount: amt(c.withdrawableNow, TRX) });
        case 'cancelAllUnfreeze':
          return t('staking.plainTronCancel');
        case 'claimRewards':
          return t('staking.plainTronClaim', { amount: amt(c.reward, TRX) });
        case 'vote':
          return t('staking.plainTronVote', { total: x.total, count: x.votes.length });
      }
    },
    review: (b) => {
      const x = b.summary.action;
      const c = b.context;
      return (
        <>
          {x.type === 'vote' &&
            x.votes.map((v) => {
              const w = c.witnesses.find((y) => y.address === v.address);
              const warn = c.warnings.some((k) => k.kind !== 'votesReduced' && k.address === v.address);
              return <Row key={v.address} k={t('staking.votesCount', { count: v.count })} v={t('staking.voteReview', { sr: w?.url ?? shortAddress(v.address), rank: w?.rank ?? '?', brokerage: w?.brokerage ?? '?' })} {...(warn ? { tone: 'warn' as const } : {})} />;
            })}
          {(x.type === 'freeze' || x.type === 'unfreeze') && <Row k={t('staking.rowResource')} v={x.resource === 'ENERGY' ? t('staking.energy') : t('staking.bandwidth')} />}
          {(x.type === 'freeze' || x.type === 'unfreeze') && <Row k={t('staking.rowUnfreezeDelay')} v={tp('time.days', c.account.unfreezeDelayDays)} />}
          <Row k="TRON Power" v={t('staking.tronPowerBefore', { used: c.account.tronPowerUsed, limit: c.account.tronPowerLimit })} {...(c.warnings.some((k) => k.kind === 'votesReduced') ? { tone: 'warn' as const } : {})} />
          <Row k={t('staking.rowBandwidth')} v={BigInt(c.estimate.bandwidthBurn) > 0n ? t('staking.bandwidthBurned', { bytes: c.estimate.bandwidthNeeded, amount: amt(c.estimate.bandwidthBurn, TRX) }) : t('staking.bandwidthCovered', { bytes: c.estimate.bandwidthNeeded })} />
          <Row k={t('staking.rowExpires')} v={fmtWhen(b.summary.expiration)} />
          <Row k="ID" v={<span className="font-mono text-[12px]">{shortAddress(b.txid, 10, 8)}</span>} />
          <Row k={t('staking.rowRisk')} v={t('staking.riskTron')} />
        </>
      );
    },
    warnings: (b) => b.context.warnings.map((w) => tronWarningText(w, b.context.witnesses)),
    sign: async (b, password) => ({ ...(await call('tron_stake_sign', { raw: b.raw, password, ...acct('tron') })), raw: b.raw }),
    broadcast: (s) => call('tron_broadcast', { raw: s.raw, signature: s.signature, ...acct('tron') }),
    doneText: t('staking.doneTron'),
  };
  return <StakeFlowDialog spec={spec} onClose={onClose} onDone={onDone} />;
}
