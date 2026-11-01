// SPDX-License-Identifier: GPL-3.0-or-later
//
// Staking (docs/IPC.md §2.8): Solana (native Stake program), Cardano (pool + vote delegation),
// TRON (Stake 2.0 + SR votes). The UI only CHOOSES an operation: Rust builds it
// (`*_stake_build`), the decoded result and its live context are shown BEFORE the password,
// `*_stake_sign` opens the native windows (the reinforced one included), then the broadcast.
// Never a message, a CBOR or a raw_data built or edited here. Not offered on hardware wallets.

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
  SOL_STATE_LABEL,
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

/** `{ account }` of the selected vault account of a staking chain (§2.9; nothing for account 0). */
function useStakeAccount(): (chain: StakeChain) => { account?: number } {
  const { selectedAccounts } = useApp();
  return (chain) => (selectedAccounts[chain] ? { account: selectedAccounts[chain] } : {});
}

type Ret<K extends keyof Commands> = Commands[K]['ret'];

const SOL = { decimals: 9, symbol: 'SOL' };
const ADA = { decimals: 6, symbol: 'ADA' };
const TRX = { decimals: 6, symbol: 'TRX' };
/** Exact amount (every significant decimal: staking numbers are shown as Rust computes them). */
const amt = (v: string | bigint | null | undefined, u: { decimals: number; symbol: string }) => (v === null || v === undefined ? '—' : fmtCrypto(BigInt(v), u.decimals, u.symbol, u.decimals));

const NO_SLASHING = 'Pas de slashing sur cette chaîne : tes fonds ne peuvent pas être confisqués. Mais les récompenses dépendent du validateur, du pool ou du SR que tu choisis.';

// ================================================================= screen

export function Staking({ chain }: { chain?: StakeChain }) {
  const { activeHw, navigate, hwOnly } = useApp();
  const { accounts } = useVault();
  const tab: 'home' | StakeChain = chain ?? 'home';
  const has: Record<StakeChain, boolean> = { sol: !!accounts.sol, ada: !!accounts.cardano, tron: !!accounts.tron };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 pt-6 pb-5 scroll-thin">
      <header className="flex items-end justify-between gap-4 border-b border-line pb-4">
        <div className="flex flex-col gap-2">
          <h1 className="screen-title">Staking</h1>
          <span className="text-[13px] text-mute">Délègue tes SOL, ADA ou TRX depuis tes propres comptes. Tes fonds restent à toi.</span>
        </div>
        {tab !== 'home' && !activeHw && <AccountPicker family={tab} />}
        <Segmented
          label="Chaîne"
          value={tab}
          onChange={(v) => navigate(v === 'home' ? { name: 'staking' } : { name: 'staking', chain: v })}
          options={[
            { value: 'home', label: 'Vue d’ensemble' },
            { value: 'sol', label: 'Solana', disabled: !!activeHw || !has.sol },
            { value: 'ada', label: 'Cardano', disabled: !!activeHw || !has.ada },
            { value: 'tron', label: 'TRON', disabled: !!activeHw || !has.tron },
          ]}
        />
      </header>
      {activeHw && (
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          <strong className="font-semibold text-text">Staking indisponible avec un hardware wallet.</strong> Le compte actif est « {activeHw.label} » : Kyro ne propose pas encore le staking sur Ledger ou Trezor. {hwOnly ? 'Le staking passe par un coffre Kyro (phrase de récupération) : il n’y en a pas sur cet ordinateur.' : 'Passe sur le coffre Kyro (sélecteur de compte, en haut) pour staker.'}
        </Notice>
      )}
      {tab === 'home' || activeHw ? <StakingHome disabled={!!activeHw} has={has} /> : tab === 'sol' ? <SolStaking /> : tab === 'ada' ? <AdaStaking /> : <TronStaking />}
    </div>
  );
}

function StakingHome({ disabled, has }: { disabled: boolean; has: Record<StakeChain, boolean> }) {
  const { navigate, network, hideBalances } = useApp();
  const acct = useStakeAccount();
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
      what: 'Délègue à un validateur depuis un compte de staking à ton nom. Activation et refroidissement : ≈ 1 époque (≈ 2 jours) chacun.',
      line: sol.data ? `${sol.data.accounts.length} compte${sol.data.accounts.length > 1 ? 's' : ''} de staking · ${hide(amt(solStaked, SOL))}` : null,
      error: sol.error,
    },
    {
      chain: 'ada',
      name: 'Cardano',
      glyph: 'A',
      color: '#3468D1',
      what: 'Délègue à un pool : tes ADA restent sur ton adresse et restent dépensables. Dépôt de 2 ADA, rendu à l’arrêt.',
      line: ada.data ? (ada.data.stake.registered ? `Pool ${ada.data.pool?.ticker ?? shortAddress(ada.data.stake.delegatedPool ?? '—')} · récompenses ${hide(amt(ada.data.stake.rewardsAvailable, ADA))}` : 'Pas encore de délégation') : null,
      error: ada.error,
    },
    {
      chain: 'tron',
      name: 'TRON',
      glyph: 'T',
      color: '#EB0029',
      what: `Stake pour de l’énergie ou de la bande passante, puis vote pour des SR. Dégel : ${network === 'mainnet' ? '14 jours' : '1 jour sur Nile (14 sur mainnet)'}.`,
      line: tron.data ? `${hide(amt(tronStaked, TRX))} stakés · ${tron.data.tronPowerUsed} / ${tron.data.tronPowerLimit} TRON Power votés` : null,
      error: tron.error,
    },
  ];
  return (
    <>
      <div className="grid shrink-0 grid-cols-3 divide-x divide-line overflow-hidden rounded-panel border border-line bg-card">
        {cards.map((c, i) => (
          <div key={c.chain} className="rise group flex flex-col gap-3 px-5 pt-4 pb-5" style={idx(i)}>
            <div className="flex items-center gap-2.5">
              <CoinIcon glyph={c.glyph} color={c.color} size={26} />
              <span className="text-[20px] font-semibold tracking-[-0.02em]">{c.name}</span>
              <span className="text-[12px] text-mute">{networkLabel(c.chain, network)}</span>
            </div>
            <p className="m-0 text-[13px] leading-[1.55] text-text2">{c.what}</p>
            <div className="min-h-5 border-t border-line pt-3 text-[13px] font-medium">
              {disabled || !has[c.chain] ? (
                <span className="font-normal text-mute">{disabled ? 'Indisponible sur un hardware wallet' : 'Aucun compte sur cette chaîne'}</span>
              ) : c.error ? (
                <ErrorLine error={c.error}>{c.error.message}</ErrorLine>
              ) : (
                c.line ?? <Skeleton className="h-4 w-48" />
              )}
            </div>
            <div className="flex-1" />
            <Button variant="outline" className="justify-between" disabled={disabled || !has[c.chain]} onClick={() => navigate({ name: 'staking', chain: c.chain })}>
              Ouvrir le staking {c.name}
              <IconChevronRight size={15} className="nudge text-mute" />
            </Button>
          </div>
        ))}
      </div>
      <Card className="flex flex-col gap-2 border-l-2 border-l-ice/70 px-5 py-4">
        <span className="flex items-center gap-2 text-[14px] font-medium">
          <IconShield size={16} className="text-ice" /> Risques
        </span>
        <p className="m-0 text-[13px] leading-[1.6] text-text2">
          Sur Solana, Cardano et TRON, il n’y a <strong className="font-semibold text-text">pas de slashing</strong> : un validateur, un pool ou un SR qui se comporte mal ne peut pas te prendre tes fonds. En revanche, <strong className="font-semibold text-text">tes récompenses dépendent de lui</strong> (sa commission, sa marge, sa fiabilité) et elles ne sont jamais garanties. Les noms affichés sont déclarés par leurs opérateurs, pas vérifiés.
        </p>
      </Card>
      <Card className="flex flex-col px-5 py-2">
        {[
          ['Bitcoin, Litecoin, Dogecoin', 'Pas de staking natif : ces protocoles n’en ont pas.'],
          ['XRP Ledger', 'Pas de staking natif.'],
          ['NEAR', 'Staking via des pools (contrats) : pas encore dans Kyro.'],
          ['Ethereum et chaînes EVM', 'Non proposé : le staking natif exige 32 ETH et un validateur qui tourne en permanence, et Kyro ne passe pas par le contrat d’un tiers.'],
        ].map(([k, v]) => (
          <div key={k} className="flex min-h-11 items-center justify-between gap-4 border-b border-line py-2 text-[13px] last:border-b-0">
            <span className="font-medium text-text2">{k}</span>
            <span className="text-right text-mute">{v}</span>
          </div>
        ))}
      </Card>
    </>
  );
}

// ================================================================= shared flow

interface FlowSpec<B, S> {
  title: string;
  /** Inputs (validator, amount…); absent: the operation is built at once. */
  form?: ReactNode;
  canBuild?: boolean;
  build: () => Promise<B>;
  /** One plain-language sentence. */
  enClair: (b: B) => ReactNode;
  review: (b: B) => ReactNode;
  /** Same triggers as Rust's reinforced window. */
  warnings: (b: B) => string[];
  sign: (b: B, password: string) => Promise<S>;
  broadcast: (s: S) => Promise<string>;
  doneText: string;
}

function errText(e: unknown): string {
  const err = toIpcError(e);
  return err.code === 'USER_REJECTED' ? 'Signature annulée dans la fenêtre système. Rien n’a été envoyé.' : err.message;
}

function StakeFlowDialog<B, S>({ spec, onClose, onDone }: { spec: FlowSpec<B, S>; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<'form' | 'review' | 'done'>(spec.form ? 'form' : 'review');
  const [built, setBuilt] = useState<B | null>(null);
  const [busy, setBusy] = useState<'build' | 'sign' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [password, setPassword] = useState('');
  const [txid, setTxid] = useState<string | null>(null);

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
  // No form: the operation is built as soon as the window opens.
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
            <Button onClick={onClose}>Annuler</Button>
            <Button variant="primary" disabled={spec.canBuild === false || busy !== null} onClick={() => void build()}>
              {busy === 'build' && <Spinner />} Vérifier
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
                <Spinner /> Construction par Kyro (lecture en direct du réseau)…
              </div>
            )
          ) : (
            <>
              <EnClair>{spec.enClair(built)}</EnClair>
              <dl className="m-0 flex flex-col text-[13px]">{spec.review(built)}</dl>
              <SecondConfirmNotice lines={warnings} />
              <p className="m-0 text-[12px] leading-[1.5] text-mute">Décodé et vérifié par Kyro. Au moment de signer, tout est relu en direct : si quelque chose a changé, la signature est refusée. La fenêtre système affichera ce même résumé.</p>
              <PasswordField id="stake-password" value={password} onChange={setPassword} autoFocus onEnter={() => password && busy === null && void sign()} invalid={toIpcError(error).code === 'WRONG_PASSWORD'} />
              {error !== null && <ErrorLine error={error}>{errText(error)}</ErrorLine>}
              <div className="flex justify-end gap-2">
                {spec.form ? (
                  <Button disabled={busy !== null} onClick={() => (setStep('form'), setBuilt(null), setError(null))}>
                    Modifier
                  </Button>
                ) : (
                  <Button disabled={busy !== null} onClick={onClose}>
                    Annuler
                  </Button>
                )}
                <Button variant="primary" disabled={!password || busy !== null} onClick={() => void sign()}>
                  {busy === 'sign' && <Spinner />} Signer et diffuser
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
            Fermer
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
            Max
          </Button>
        )}
      </div>
      {hint && <span className="text-[12px] leading-[1.5] text-mute">{hint}</span>}
    </div>
  );
}

/** Epoch progress; `slotSecs`: 0.4 on Solana, 1 on Cardano. Counts down locally between reloads. */
function EpochBar({ epoch, slotsInEpoch, slotSecs, secondsLeft, loadedAt, label }: { epoch: number; slotsInEpoch: number; slotSecs: number; secondsLeft: number; loadedAt: number | null; label: string }) {
  const now = useNow(1000);
  const left = Math.max(0, secondsLeft - (loadedAt ? (now - loadedAt) / 1000 : 0));
  const pct = Math.max(0, Math.min(100, (1 - left / (slotsInEpoch * slotSecs)) * 100));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium">
          {label} <span className="font-mono">{epoch}</span>
        </span>
        <span className="text-mute">fin dans {fmtDuration(left)}</span>
      </div>
      <div className="h-[3px] overflow-hidden rounded-full bg-control-2" role="progressbar" aria-label={`Avancement de l’${label.toLowerCase()} ${epoch}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="h-full rounded-full bg-ice transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SortBar<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="eyebrow">{label}</span>
      <Segmented size="sm" label="Trier par" value={value} onChange={onChange} options={options} />
    </div>
  );
}

// ================================================================= Solana

function ValidatorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useAsync(() => call('sol_stake_validators', {}), []);
  const [sort, setSort] = useState<SolSort>('commission');
  const sorted = useMemo(() => sortValidators(list.data?.validators ?? [], sort), [list.data, sort]);
  return (
    <div className="flex flex-col gap-2">
      <SortBar label="Validateur" value={sort} onChange={setSort} options={[{ value: 'commission', label: 'Commission' }, { value: 'stake', label: 'Stake actif' }]} />
      {list.error ? (
        <ErrorLine error={list.error} onRetry={list.reload}>
          {list.error.message}
        </ErrorLine>
      ) : !list.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div role="radiogroup" aria-label="Validateurs" className="flex max-h-[240px] flex-col overflow-y-auto rounded-ctl border border-line scroll-thin">
          {sorted.map((v) => (
            <ValidatorRow key={v.voteAccount} v={v} selected={v.voteAccount === value} onSelect={() => onChange(v.voteAccount)} />
          ))}
        </div>
      )}
      {list.data && !list.data.namesAvailable && <Hint>Noms indisponibles : seuls les comptes de vote sont affichés.</Hint>}
      <Hint>Les noms sont déclarés par les validateurs eux-mêmes, pas vérifiés. Au-delà de 10 % de commission ou si le validateur est en retard, la fenêtre système te demandera une 2ᵉ confirmation.</Hint>
    </div>
  );
}

function ValidatorRow({ v, selected, onSelect }: { v: SolValidator; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className={cn('flex items-center gap-3 border-b border-line px-3 py-2 text-left text-[13px] last:border-b-0', selected ? 'bg-ice/[.07]' : 'hover:bg-raised')}>
      <span className={cn('size-3.5 shrink-0 rounded-full border-2 transition-colors duration-150', selected ? 'border-ice bg-ice shadow-[inset_0_0_0_2px_var(--color-bg)]' : 'border-line-3')} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">
          {v.name ?? 'Sans nom'} {v.name && <span className="font-normal text-faint">(déclaré)</span>}
        </span>
        <span className="truncate font-mono text-[11px] text-faint">{shortAddress(v.voteAccount, 8, 6)}</span>
      </span>
      <span className="flex shrink-0 flex-wrap justify-end gap-1">
        {solValidatorBadges(v).map((b) => (
          <Badge key={b.text} tone={b.tone}>
            {b.text}
          </Badge>
        ))}
      </span>
      <span className="w-16 shrink-0 text-right">{v.commission} %</span>
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
            <Stat k="Disponible" v={h(amt(o.balance, SOL))} sub="sur ton adresse" />
            <Stat k="Dans tes comptes de staking" v={h(amt(total, SOL))} sub={`${o.accounts.length} compte${o.accounts.length > 1 ? 's' : ''}`} />
            <Stat k="Minimum de délégation" v={amt(o.minimumDelegation, SOL)} sub={`+ réserve de rent ${amt(o.rentExemptReserve, SOL)} (${networkLabel('sol', network)})`} />
          </div>
          <Button variant="primary" size="lg" onClick={() => setOp({ kind: 'create' })}>
            Staker des SOL
          </Button>
        </div>
        <EpochBar label="Époque" epoch={o.epoch.epoch} slotsInEpoch={o.epoch.slotsInEpoch} slotSecs={0.4} secondsLeft={o.epoch.secondsLeft} loadedAt={ov.updatedAt} />
        <Hint>Une délégation s’active au début de l’époque suivante (≈ 2 jours par époque). Après « Désactiver », il faut attendre le refroidissement, environ une époque (≈ 2 jours, sans récompense), avant de pouvoir retirer. {NO_SLASHING}</Hint>
      </Card>

      <Card className="flex flex-col">
        <div className="flex h-[50px] items-center border-b border-line px-5 text-[15px] font-medium tracking-[-0.01em]">Tes comptes de staking</div>
        {o.accounts.length === 0 ? (
          <EmptyState title="Aucun compte de staking">« Staker des SOL » crée un compte de staking à ton nom (toi seul peux le gérer et le retirer) et le délègue au validateur choisi.</EmptyState>
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
                    <Badge tone={solStateTone(a.state)}>{SOL_STATE_LABEL[a.state]}</Badge>
                    <span className="truncate font-mono text-[12px] text-text2">{shortAddress(a.address, 8, 6)}</span>
                    {!a.ours && <Badge>Lecture seule</Badge>}
                  </span>
                  <span className="text-mute">
                    {a.voteAccount ? (
                      <>
                        {v?.name ?? shortAddress(a.voteAccount, 8, 6)}
                        {v?.name && ' (déclaré)'}
                        {v && ` · commission ${v.commission} %`}
                        {v?.delinquent && <span className="text-down"> · en retard</span>}
                      </>
                    ) : (
                      'Non délégué'
                    )}
                    {a.state === 'activating' && a.activationEpoch !== null && ` · actif à l’époque ${a.activationEpoch + 1}`}
                    {a.state === 'deactivating' && a.deactivationEpoch !== null && ` · retirable à l’époque ${a.deactivationEpoch + 1}`}
                  </span>
                  {!a.ours && <span className="text-faint">{a.lockupInForce ? 'Blocage (lockup) en cours' : 'Autorités différentes de ton adresse'} : Kyro ne le gère pas.</span>}
                </div>
                <div className="flex w-44 shrink-0 flex-col items-end">
                  <span className="font-semibold">{h(amt(a.lamports, SOL))}</span>
                  <span className="text-[12px] text-mute">
                    {a.state === 'activating' ? `${h(amt(a.activating, SOL))} en activation` : a.state === 'deactivating' ? `${h(amt(a.deactivating, SOL))} en refroidissement` : `effectif ${h(amt(a.effective, SOL))}`}
                  </span>
                  {BigInt(a.withdrawable) > 0n && <span className="text-[12px] text-faint">retirable {h(amt(a.withdrawable, SOL))}</span>}
                </div>
                <div className="flex w-[240px] shrink-0 justify-end gap-2">
                  {a.ours && canDeactivate && (
                    <Button size="sm" onClick={() => setOp({ kind: 'deactivate', acc: a })}>
                      Désactiver
                    </Button>
                  )}
                  {a.ours && canDelegate && (
                    <Button size="sm" onClick={() => setOp({ kind: 'delegate', acc: a })}>
                      Déléguer
                    </Button>
                  )}
                  {a.ours && canWithdraw && (
                    <Button size="sm" variant="ice" onClick={() => setOp({ kind: 'withdraw', acc: a })}>
                      Retirer
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

  let title: string;
  let form: ReactNode | undefined;
  let canBuild = true;
  let action: Commands['sol_stake_build']['args']['action'];
  if (op.kind === 'create') {
    title = 'Staker des SOL';
    canBuild = !!lamports && lamports >= min && !!vote;
    action = { kind: 'createAndDelegate', lamports: (lamports ?? 0n).toString(), voteAccount: vote };
    form = (
      <>
        <AmountField
          id="sol-stake-amount"
          label="Montant à déléguer"
          value={amount}
          onChange={setAmount}
          unit={SOL}
          onMax={() => setAmount(toInputDecimal(maxCreate > 0n ? maxCreate : 0n, 9))}
          hint={
            <>
              Minimum {amt(min, SOL)}{network === 'testnet' ? ' sur devnet' : ''}. Kyro ajoute la réserve de rent du compte de staking ({amt(rent, SOL)}), rendue quand tu fermes le compte. Disponible : {amt(o.balance, SOL)}.
              {lamports !== null && lamports > 0n && lamports < min && <span className="text-warn"> Sous le minimum de délégation.</span>}
            </>
          }
        />
        <ValidatorPicker value={vote} onChange={setVote} />
      </>
    );
  } else if (op.kind === 'delegate') {
    title = 'Déléguer ce compte';
    canBuild = !!vote;
    action = { kind: 'delegate', stakeAccount: op.acc.address, voteAccount: vote };
    form = <ValidatorPicker value={vote} onChange={setVote} />;
  } else if (op.kind === 'deactivate') {
    title = 'Désactiver le stake';
    action = { kind: 'deactivate', stakeAccount: op.acc.address };
  } else {
    title = 'Retirer du compte de staking';
    const max = BigInt(op.acc.canClose ? op.acc.lamports : op.acc.withdrawable);
    canBuild = !!lamports && lamports > 0n && lamports <= max;
    action = { kind: 'withdraw', stakeAccount: op.acc.address, lamports: (lamports ?? 0n).toString() };
    form = (
      <AmountField
        id="sol-withdraw-amount"
        label="Montant à retirer vers ton adresse"
        value={amount}
        onChange={setAmount}
        unit={SOL}
        onMax={() => setAmount(toInputDecimal(max, 9))}
        hint={op.acc.canClose ? 'Tout retirer ferme le compte de staking (la réserve de rent revient avec).' : `Retirable sans fermer le compte : ${amt(max, SOL)} (récompenses et excédent). Le reste est délégué : désactive-le d’abord.`}
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
      const v = s.validator ? `${s.validator.name ?? shortAddress(s.validator.voteAccount)} (commission ${s.validator.commission} %)` : '';
      if (s.kind === 'createAndDelegate') return `Tu crées un compte de staking à ton nom avec ${amt(s.lamports, SOL)} (dont ${amt(s.rentExemptReserve, SOL)} de réserve de rent) et tu délègues ${amt(s.delegated, SOL)} à ${v}. Actif à l’époque ${s.epoch.epoch + 1}.`;
      if (s.kind === 'delegate') return `Tu délègues ce compte à ${v}. Actif à l’époque ${s.epoch.epoch + 1}.`;
      if (s.kind === 'deactivate') return `Tu arrêtes de staker ce compte. Refroidissement jusqu’à la fin de l’époque ${s.epoch.epoch} (${fmtDuration(s.epoch.secondsLeft)}, sans récompense), puis tu pourras retirer.`;
      return `Tu retires ${amt(s.lamports, SOL)} vers ton adresse${s.closesAccount ? ' et tu fermes le compte de staking' : ''}.`;
    },
    review: (b) => {
      const s = b.stake;
      return (
        <>
          <Row k="Compte de staking" v={<span className="font-mono text-[12px]">{shortAddress(s.stakeAccount, 10, 8)}</span>} />
          {s.kind === 'createAndDelegate' && <Row k="Versé au compte" v={`${amt(s.lamports, SOL)} = ${amt(s.delegated, SOL)} délégués + ${amt(s.rentExemptReserve, SOL)} de rent`} />}
          {s.kind === 'delegate' && <Row k="Délégué" v={amt(s.delegated, SOL)} />}
          {s.kind === 'deactivate' && <Row k="Délégué actuellement" v={amt(s.delegated, SOL)} />}
          {s.kind === 'withdraw' && <Row k="Retiré vers ton adresse" v={`${amt(s.lamports, SOL)}${s.closesAccount ? ' · ferme le compte' : ''}`} />}
          {s.validator && (
            <Row
              k="Validateur"
              v={
                <span className="flex flex-col items-end">
                  <span>
                    {s.validator.name ?? 'Sans nom'} {s.validator.name && <span className="text-faint">(déclaré)</span>} · commission {s.validator.commission} %
                    {s.validator.delinquent && <span className="text-down"> · en retard</span>}
                  </span>
                  <span className="font-mono text-[11px] text-faint">vote {shortAddress(s.validator.voteAccount, 8, 6)} · stake actif {fmtStake(s.validator.activatedStake, 9, 'SOL')}</span>
                </span>
              }
              {...(s.warnings.length ? { tone: 'warn' as const } : {})}
            />
          )}
          <Row k="Époque" v={`${s.epoch.epoch} · fin dans ${fmtDuration(s.epoch.secondsLeft)}`} />
          <Row k="Instructions" v={b.summary.instructions.map(instructionLabel).join(' · ')} />
          <Row k="Autorités" v="ton adresse (staker et withdrawer), aucun blocage" />
          <Row k="Frais réseau" v={amt(s.fee, SOL)} />
          <Row k="Risque" v="pas de slashing ; récompenses selon le validateur" />
        </>
      );
    },
    warnings: (b) => b.stake.warnings.map(solWarningText),
    sign: async (b, password) => ({ ...(await call('sol_stake_sign', { message: b.message, password, ...acct('sol') })), message: b.message }),
    broadcast: (s) => call('sol_stake_broadcast', { message: s.message, signature: s.signature, ...acct('sol') }),
    doneText: 'Opération de staking diffusée. L’état du compte se met à jour au prochain rafraîchissement (l’activation ou le refroidissement suit le calendrier des époques).',
  };
  return <StakeFlowDialog spec={spec} onClose={onClose} onDone={onDone} />;
}

// ================================================================= Cardano

function DrepChoice({ mode, onMode, custom, onCustom, keepCurrent }: { mode: DrepMode | 'keep'; onMode: (m: DrepMode | 'keep') => void; custom: string; onCustom: (v: string) => void; keepCurrent: string | null }) {
  const opts: { value: DrepMode | 'keep'; title: string; text: string }[] = [
    ...(keepCurrent ? [{ value: 'keep' as const, title: `Garder mon vote actuel (${drepLabel(keepCurrent)})`, text: 'Ta délégation de vote ne change pas.' }] : []),
    { value: 'alwaysAbstain', title: 'Toujours s’abstenir (suggéré)', text: 'Personne ne vote en ton nom : ton stake est compté comme abstention. Le choix neutre, et il débloque le retrait des récompenses.' },
    { value: 'alwaysNoConfidence', title: 'Toujours défiance', text: 'Ton stake compte comme un vote de défiance envers le comité constitutionnel, et comme « non » sur les autres propositions.' },
    { value: 'custom', title: 'Un représentant (DRep)', text: 'Une personne ou une organisation vote pour toi selon ses positions. Saisis son identifiant drep1… (vérifie-le à la source).' },
  ];
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="pb-1 text-[12px] font-medium text-mute">Délégation de vote (gouvernance)</legend>
      <p className="m-0 text-[12px] leading-[1.55] text-mute">
        Depuis la mise à jour Conway, chaque compte qui stake délègue aussi son <strong className="font-semibold text-text2">vote de gouvernance</strong> à un « DRep ». Sans délégation de vote, le réseau refuse le retrait de tes récompenses. Ça ne touche ni à tes ADA, ni au pool.
      </p>
      {opts.map((o) => (
        <label key={o.value} className={cn('flex cursor-pointer items-start gap-3 rounded-ctl border px-3 py-2.5 text-[13px]', mode === o.value ? 'border-ice/50 bg-ice/[.06]' : 'border-line hover:bg-raised')}>
          <input type="radio" name="drep" className="mt-1 accent-[#7CC4FF]" checked={mode === o.value} onChange={() => onMode(o.value)} />
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold">{o.title}</span>
            <span className="text-[12px] leading-[1.5] text-mute">{o.text}</span>
          </span>
        </label>
      ))}
      {mode === 'custom' && <Input aria-label="Identifiant du DRep" placeholder="drep1…" value={custom} onChange={(e) => onCustom(e.target.value)} className="font-mono text-[13px]" />}
      {mode === 'custom' && custom.trim() !== '' && drepArg('custom', custom) === null && <span className="text-[12px] text-warn">Identifiant attendu : drep1… ou drep_script1…</span>}
    </fieldset>
  );
}

function PoolPicker({ value, onChange }: { value: string; onChange: (id: string, pool: AdaPool | null) => void }) {
  const list = useAsync(() => call('ada_stake_pools', { limit: 50 }), []);
  const [sort, setSort] = useState<AdaSort>('margin');
  const [typed, setTyped] = useState('');
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
        label="Pool"
        value={sort}
        onChange={setSort}
        options={[
          { value: 'margin', label: 'Marge' },
          { value: 'saturation', label: 'Saturation' },
          { value: 'stake', label: 'Stake' },
        ]}
      />
      {list.error ? (
        <ErrorLine error={list.error} onRetry={list.reload}>
          {list.error.message}
        </ErrorLine>
      ) : !list.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div role="radiogroup" aria-label="Pools" className="flex max-h-[220px] flex-col overflow-y-auto rounded-ctl border border-line scroll-thin">
          {rows.map((p) => {
            const selected = p.poolId === value;
            return (
              <button key={p.poolId} type="button" role="radio" aria-checked={selected} onClick={() => onChange(p.poolId, p)} className={cn('flex items-center gap-3 border-b border-line px-3 py-2 text-left text-[13px] last:border-b-0', selected ? 'bg-ice/10' : 'hover:bg-raised')}>
                <span className={cn('size-3.5 shrink-0 rounded-full border-2 transition-colors duration-150', selected ? 'border-ice bg-ice shadow-[inset_0_0_0_2px_var(--color-bg)]' : 'border-line-3')} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold">
                    {p.ticker ?? '—'} <span className="font-normal text-text2">{p.name ?? ''}</span> <span className="font-normal text-faint">(déclaré)</span>
                  </span>
                  <span className="truncate text-[11px] text-faint">
                    coût fixe {amt(p.fixedCost, ADA)} · {p.liveDelegators ?? '—'} délégants
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {adaPoolBadges(p).map((b) => (
                    <Badge key={b.text} tone={b.tone}>
                      {b.text}
                    </Badge>
                  ))}
                </span>
                <span className="w-14 shrink-0 text-right">{fmtNumber(p.margin * 100, 1)} %</span>
                <span className="w-16 shrink-0 text-right text-mute">{p.liveSaturation !== null ? `${fmtNumber(p.liveSaturation, 1)} %` : '—'}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex gap-2">
        <Input aria-label="Identifiant de pool" placeholder="Ou un identifiant pool1… / 56 hex" value={typed} onChange={(e) => setTyped(e.target.value)} className="h-10 font-mono text-[12px]" />
        <Button disabled={!typed.trim() || lookup.busy} onClick={() => void find()}>
          {lookup.busy && <Spinner />} Chercher
        </Button>
      </div>
      {lookup.error !== null && <ErrorLine error={lookup.error}>{toIpcError(lookup.error).message}</ErrorLine>}
      <Hint>Colonnes : marge (part des récompenses gardée par le pool) et saturation. Marge au-delà de 10 %, pool saturé (&gt; 100 %) ou qui part à la retraite : 2ᵉ confirmation dans la fenêtre système.</Hint>
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
            <Stat k="Délégué (tout ce que contrôle ta clé)" v={h(amt(s.totalBalance, ADA))} sub="tes ADA restent sur ton adresse, dépensables" />
            <Stat k="Récompenses disponibles" v={h(amt(s.rewardsAvailable, ADA))} sub="dépensables après « Retirer »" />
            <Stat k="Dépôt de la clé de staking" v={s.registered ? amt(s.deposit, ADA) : 'aucun'} sub={s.registered ? 'rendu quand tu arrêtes le staking' : `${amt(o.keyDeposit, ADA)} à la 1ʳᵉ délégation, rendus à l’arrêt`} />
          </div>
          <Button variant="primary" size="lg" onClick={() => setOp('delegate')}>
            {s.registered && s.delegatedPool ? 'Changer de pool' : 'Déléguer'}
          </Button>
        </div>
        <EpochBar label="Époque" epoch={o.epoch.epoch} slotsInEpoch={o.epoch.epochLength} slotSecs={1} secondsLeft={o.epoch.secondsLeft} loadedAt={ov.updatedAt} />
        <Hint>Une délégation compte à partir de la 2ᵉ époque qui suit (5 à 10 jours), premières récompenses au début de la 4ᵉ (15 à 20 jours), puis à chaque époque de 5 jours. Pas de blocage : tu peux dépenser tes ADA à tout moment. {NO_SLASHING}</Hint>
      </Card>

      <Card className="flex flex-col">
        <div className="flex h-[50px] items-center justify-between border-b border-line px-5">
          <span className="text-[15px] font-medium tracking-[-0.01em]">Ta délégation ({networkLabel('ada', network)})</span>
          <span className="font-mono text-[11px] text-faint">{shortAddress(s.stakeAddress, 12, 6)}</span>
        </div>
        <dl className="m-0 flex flex-col px-5 py-1 text-[13px]">
          <Row k="Clé de staking" v={s.registered ? <Badge tone="up">Enregistrée</Badge> : <Badge>Non enregistrée</Badge>} />
          <Row
            k="Pool"
            v={
              o.pool ? (
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  <span>
                    {o.pool.ticker} · {o.pool.name} <span className="text-faint">(déclaré)</span> · marge {fmtNumber(o.pool.margin * 100, 1)} % · saturation {o.pool.liveSaturation !== null ? `${fmtNumber(o.pool.liveSaturation, 1)} %` : '—'}
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
                'aucun'
              )
            }
          />
          <Row k="Vote (DRep)" v={drepLabel(s.delegatedDrep)} {...(s.registered && !s.delegatedDrep ? { tone: 'warn' as const } : {})} />
        </dl>
        {s.registered && rewards > 0n && !o.canWithdraw && (
          <Notice tone="warn" className="mx-5 mb-3" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            Pour retirer tes récompenses, le réseau exige une <strong className="font-semibold text-text">délégation de vote</strong> (règle Cardano depuis Plomin). « Toujours s’abstenir » suffit et ne vote rien en ton nom.{' '}
            <button type="button" className="font-semibold text-ice hover:underline" onClick={() => setOp('vote')}>
              Déléguer mon vote
            </button>
          </Notice>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
          <Button size="sm" onClick={() => setOp('vote')}>
            {s.delegatedDrep ? 'Changer mon vote' : 'Déléguer mon vote'}
          </Button>
          <Button size="sm" variant="ice" disabled={!o.canWithdraw} title={o.canWithdraw ? undefined : rewards === 0n ? 'Aucune récompense à retirer' : 'Délègue d’abord ton vote'} onClick={() => setOp('withdraw')}>
            Retirer les récompenses
          </Button>
          <Button size="sm" variant="dangerOutline" disabled={!s.registered} onClick={() => setOp('deregister')}>
            Arrêter le staking
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

  let title: string;
  let form: ReactNode | undefined;
  let canBuild = true;
  let action: Commands['ada_stake_build']['args']['action'];
  if (op === 'delegate') {
    title = o.stake.delegatedPool ? 'Changer de pool' : 'Déléguer à un pool';
    canBuild = !!poolId && drepOk;
    action = { kind: 'delegate', poolId, ...(drep ? { drep } : {}) };
    form = (
      <>
        {!o.stake.registered && (
          <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
            1ʳᵉ délégation : Kyro enregistre ta clé de staking, avec un <strong className="font-semibold text-text">dépôt de {amt(o.keyDeposit, ADA)}</strong> exigé par le réseau. Il t’est rendu quand tu arrêtes le staking.
          </Notice>
        )}
        <PoolPicker value={poolId} onChange={(id) => setPoolId(id)} />
        <DrepChoice mode={mode} onMode={setMode} custom={custom} onCustom={setCustom} keepCurrent={current} />
      </>
    );
  } else if (op === 'vote') {
    title = 'Délégation de vote';
    canBuild = drep !== null;
    action = { kind: 'voteDelegate', drep: drep ?? 'alwaysAbstain' };
    form = (
      <>
        {!o.stake.registered && <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>Ta clé de staking n’est pas encore enregistrée : dépôt de {amt(o.keyDeposit, ADA)}, rendu à l’arrêt.</Notice>}
        <DrepChoice mode={mode === 'keep' ? 'alwaysAbstain' : mode} onMode={setMode} custom={custom} onCustom={setCustom} keepCurrent={null} />
      </>
    );
  } else if (op === 'withdraw') {
    title = 'Retirer les récompenses';
    action = { kind: 'withdraw' };
  } else {
    title = 'Arrêter le staking';
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
        if (c.type === 'stakeRegistration') parts.push(`tu enregistres ta clé de staking (dépôt ${amt(c.deposit, ADA)}, rendu à l’arrêt)`);
        if (c.type === 'stakeDelegation') parts.push(`tu délègues au pool ${b.context.pool?.ticker ?? shortAddress(c.poolId)}`);
        if (c.type === 'voteDelegation') parts.push(`ton vote va à « ${c.drep.kind === 'alwaysAbstain' ? 'toujours s’abstenir' : c.drep.kind === 'alwaysNoConfidence' ? 'toujours défiance' : shortAddress(c.drep.id, 10, 6)} »`);
        if (c.type === 'stakeDeregistration') parts.push(`tu arrêtes le staking et récupères le dépôt de ${amt(c.refund, ADA)}`);
      }
      if (BigInt(s.withdrawn) > 0n) parts.push(`tu retires ${amt(s.withdrawn, ADA)} de récompenses`);
      const net = BigInt(b.context.netCost);
      const txt = parts.join(', ');
      return `${txt.charAt(0).toUpperCase()}${txt.slice(1)}. ${net >= 0n ? `Coût net : ${amt(net, ADA)}` : `Gain net : ${amt(-net, ADA)}`} ; tes ADA restent sur ton adresse.`;
    },
    review: (b) => {
      const s = b.summary;
      const c = b.context;
      return (
        <>
          {c.pool && (
            <Row
              k="Pool"
              v={`${c.pool.ticker ?? '—'} · ${c.pool.name ?? ''} (déclaré) · marge ${fmtNumber(c.pool.margin * 100, 1)} % · coût fixe ${amt(c.pool.fixedCost, ADA)} · pledge ${amt(c.pool.pledge, ADA)} · saturation ${c.pool.liveSaturation !== null ? `${fmtNumber(c.pool.liveSaturation, 1)} %` : '—'}`}
              {...(c.warnings.some((w) => w.kind !== 'drepInactive') ? { tone: 'warn' as const } : {})}
            />
          )}
          {c.drep && <Row k="Vote (DRep)" v={`${c.drep.drep.kind === 'alwaysAbstain' ? 'Toujours s’abstenir' : c.drep.drep.kind === 'alwaysNoConfidence' ? 'Toujours défiance' : shortAddress(c.drep.drep.id, 10, 6)}${c.drep.active ? '' : ' · inactif'}`} {...(c.drep.active ? {} : { tone: 'warn' as const })} />}
          {BigInt(s.deposit) > 0n && <Row k="Dépôt" v={`${amt(s.deposit, ADA)} (rendu à l’arrêt)`} />}
          {BigInt(s.refund) > 0n && <Row k="Remboursement du dépôt" v={amt(s.refund, ADA)} tone="up" />}
          {BigInt(s.withdrawn) > 0n && <Row k="Récompenses retirées" v={amt(s.withdrawn, ADA)} tone="up" />}
          <Row k="Frais réseau" v={amt(s.tx.fee, ADA)} />
          <Row k={BigInt(c.netCost) >= 0n ? 'Coût net' : 'Gain net'} v={amt(BigInt(c.netCost) >= 0n ? c.netCost : -BigInt(c.netCost), ADA)} />
          <Row k="Sortie" v="une seule : la monnaie, vers ton adresse" />
          <Row k="Calendrier" v={`époque ${c.epoch.epoch} : compte à l’époque ${c.epoch.epoch + 2}, récompenses dès le début de l’époque ${c.epoch.epoch + 4}`} />
          <Row k="Risque" v="pas de blocage, pas de slashing ; récompenses selon le pool" />
        </>
      );
    },
    warnings: (b) => b.context.warnings.map(adaWarningText),
    sign: (b, password) => call('ada_stake_sign', { tx: b.tx, password, ...acct('ada') }),
    broadcast: (s) => call('ada_stake_broadcast', { tx: s.tx, ...acct('ada') }),
    doneText: 'Transaction de staking Cardano diffusée. Les changements apparaissent dans l’aperçu après son inclusion dans un bloc.',
  };
  return <StakeFlowDialog spec={spec} onClose={onClose} onDone={onDone} />;
}

// ================================================================= TRON

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
            <Stat k="Disponible" v={h(amt(a.balance, TRX))} />
            <Stat k="Staké pour l’énergie" v={h(amt(a.stakedEnergy, TRX))} sub={`${a.energyLimit - a.energyUsed} / ${a.energyLimit} énergie`} />
            <Stat k="Staké pour la bande passante" v={h(amt(a.stakedBandwidth, TRX))} sub={`${a.bandwidthLimit - a.bandwidthUsed} / ${a.bandwidthLimit} octets`} />
            <Stat k="TRON Power voté" v={`${a.tronPowerUsed} / ${a.tronPowerLimit}`} sub="1 TRX staké = 1 voix" />
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            <Button variant="primary" size="lg" onClick={() => setOp('freeze')}>
              Staker des TRX
            </Button>
            <Button size="md" disabled={BigInt(a.stakedEnergy) + BigInt(a.stakedBandwidth) === 0n} onClick={() => setOp('unfreeze')}>
              Dégeler
            </Button>
          </div>
        </div>
        <Hint>
          Dégel : les TRX reviennent après {a.unfreezeDelayDays} jour{a.unfreezeDelayDays > 1 ? 's' : ''}
          {network === 'testnet' ? ' sur Nile (14 jours sur mainnet)' : ''}, puis il faut les « Retirer ». Les votes ne rapportent que pour les SR classés dans les 127 premiers, selon la part qu’ils gardent. {NO_SLASHING}
        </Hint>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card className="flex flex-col">
          <div className="flex h-[50px] items-center justify-between border-b border-line px-5">
            <span className="text-[15px] font-medium tracking-[-0.01em]">Tes votes</span>
            <Button size="sm" disabled={a.tronPowerLimit === 0} onClick={() => setOp('vote')}>
              Voter
            </Button>
          </div>
          {a.votes.length === 0 ? (
            <EmptyState title="Aucun vote">{a.tronPowerLimit > 0 ? 'Vote pour un ou plusieurs SR pour recevoir des récompenses.' : 'Stake des TRX pour obtenir du TRON Power.'}</EmptyState>
          ) : (
            a.votes.map((v) => {
              const w = byAddr.get(v.address);
              return (
                <div key={v.address} className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 text-[13px] last:border-b-0">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">
                      {w?.url ?? shortAddress(v.address)} <span className="font-normal text-faint">(déclaré)</span>
                    </span>
                    <span className="text-[11px] text-faint">{w ? `rang ${w.rank}` : shortAddress(v.address)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {w && tronWitnessBadges(w).filter((b) => b.tone === 'down').map((b) => <Badge key={b.text} tone={b.tone}>{b.text}</Badge>)}
                    <span className="font-semibold">{v.count} voix</span>
                  </span>
                </div>
              );
            })
          )}
          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-[13px]">
            <span className="flex flex-col">
              <span className="text-mute">Récompenses de vote</span>
              <span className="font-semibold">{h(amt(a.reward, TRX))}</span>
              {a.nextClaimTime > now && <span className="text-[11px] text-faint">réclamables dans {fmtDuration((a.nextClaimTime - now) / 1000)} (une fois par 24 h)</span>}
            </span>
            <Button size="sm" variant="ice" disabled={!claimable} title={claimable ? undefined : BigInt(a.reward) === 0n ? 'Aucune récompense' : 'Une réclamation par 24 h'} onClick={() => setOp('claim')}>
              Réclamer
            </Button>
          </div>
        </Card>

        <Card className="flex flex-col">
          <div className="flex h-[50px] items-center justify-between border-b border-line px-5">
            <span className="text-[15px] font-medium tracking-[-0.01em]">Dégels en cours</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={a.unfreezing.length === 0} onClick={() => setOp('cancel')}>
                Annuler les dégels
              </Button>
              <Button size="sm" variant="ice" disabled={BigInt(a.withdrawableNow) === 0n} onClick={() => setOp('withdraw')}>
                Retirer {BigInt(a.withdrawableNow) > 0n ? h(amt(a.withdrawableNow, TRX)) : ''}
              </Button>
            </div>
          </div>
          {a.unfreezing.length === 0 ? (
            <EmptyState title="Aucun dégel">Les TRX dégelés apparaissent ici avec leur date de disponibilité.</EmptyState>
          ) : (
            a.unfreezing.map((u, i) => (
              <div key={`${u.expireTime}-${i}`} className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 text-[13px] last:border-b-0">
                <span className="flex flex-col">
                  <span className="font-semibold">{h(amt(u.amount, TRX))}</span>
                  <span className="text-[11px] text-faint">{u.resource === 'ENERGY' ? 'énergie' : 'bande passante'}</span>
                </span>
                {u.expireTime <= now ? <Badge tone="up">Retirable</Badge> : <span className="text-mute">disponible le {fmtWhen(u.expireTime, now).toLowerCase()} ({fmtDuration((u.expireTime - now) / 1000)})</span>}
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
  return (
    <div className="flex flex-col gap-2">
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
        <strong className="font-semibold text-text">Un vote remplace tous tes votes actuels.</strong> Les SR que tu ne remets pas ici perdent tes voix.
      </Notice>
      <SortBar label="Super Representatives" value={sort} onChange={setSort} options={[{ value: 'rank', label: 'Rang' }, { value: 'votes', label: 'Votes' }]} />
      <div className="flex max-h-[260px] flex-col overflow-y-auto rounded-ctl border border-line scroll-thin">
        {sorted.map((w) => (
          <div key={w.address} className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[13px] last:border-b-0">
            <span className="w-9 shrink-0 text-right text-mute">#{w.rank}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-semibold">
                {w.url} <span className="font-normal text-faint">(déclaré)</span>
              </span>
              <span className="truncate text-[11px] text-faint">{fmtNumber(w.voteCount, 0)} votes</span>
            </span>
            <span className="flex shrink-0 gap-1">
              {tronWitnessBadges(w).map((b) => (
                <Badge key={b.text} tone={b.tone}>
                  {b.text}
                </Badge>
              ))}
            </span>
            <input
              aria-label={`Voix pour ${w.url}`}
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
        <span className="text-mute">{parsed?.votes.length ?? 0} SR (1 à 30)</span>
        <span className={cn('font-semibold', total > power && 'text-down')}>
          {total} / {power} TRON Power
        </span>
      </div>
      <Hint>La part gardée par chaque SR est lue au moment de vérifier. Un SR hors des 127 premiers ou qui garde 100 % : 2ᵉ confirmation dans la fenêtre système.</Hint>
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

  let title: string;
  let form: ReactNode | undefined;
  let canBuild = true;
  let action: Commands['tron_stake_build']['args']['action'];
  const resPicker = <Segmented label="Ressource" value={resource} onChange={setResource} options={[{ value: 'ENERGY', label: 'Énergie' }, { value: 'BANDWIDTH', label: 'Bande passante' }]} />;
  if (op === 'freeze') {
    title = 'Staker des TRX';
    canBuild = !!sun && sun >= 1_000_000n && sun <= BigInt(a.balance);
    action = { kind: 'freeze', resource, amount: (sun ?? 0n).toString() };
    form = (
      <>
        {resPicker}
        <AmountField id="tron-freeze" label="Montant à staker" value={amount} onChange={setAmount} unit={TRX} onMax={() => setAmount(toInputDecimal(BigInt(a.balance), 6))} hint={`Minimum 1 TRX. Disponible : ${amt(a.balance, TRX)}. Chaque TRX staké donne 1 voix de TRON Power. Le dégel prendra ${a.unfreezeDelayDays} jour${a.unfreezeDelayDays > 1 ? 's' : ''}.`} />
      </>
    );
  } else if (op === 'unfreeze') {
    title = 'Dégeler des TRX';
    canBuild = !!sun && sun > 0n && sun <= staked;
    action = { kind: 'unfreeze', resource, amount: (sun ?? 0n).toString() };
    form = (
      <>
        {resPicker}
        <AmountField id="tron-unfreeze" label="Montant à dégeler" value={amount} onChange={setAmount} unit={TRX} onMax={() => setAmount(toInputDecimal(staked, 6))} hint={`Staké pour cette ressource : ${amt(staked, TRX)}. Disponible dans ${a.unfreezeDelayDays} jour${a.unfreezeDelayDays > 1 ? 's' : ''}, puis à retirer. Si ton TRON Power passe sous tes votes, le réseau en retire une partie.`} />
      </>
    );
  } else if (op === 'vote') {
    title = 'Voter pour des SR';
    const parsed = tronVotes(counts);
    canBuild = !!parsed && parsed.votes.length >= 1 && parsed.votes.length <= 30 && parsed.total <= a.tronPowerLimit;
    action = { kind: 'vote', votes: parsed?.votes ?? [] };
    form = <VoteEditor witnesses={witnesses} counts={counts} onCounts={setCounts} power={a.tronPowerLimit} />;
  } else if (op === 'withdraw') {
    title = 'Retirer les TRX dégelés';
    action = { kind: 'withdrawUnfrozen' };
  } else if (op === 'cancel') {
    title = 'Annuler les dégels';
    action = { kind: 'cancelAllUnfreeze' };
  } else {
    title = 'Réclamer les récompenses de vote';
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
          return `Tu stakes ${amt(x.amount, TRX)} pour ${x.resource === 'ENERGY' ? 'de l’énergie' : 'de la bande passante'} (+${Number(BigInt(x.amount) / 1_000_000n)} TRON Power). Pour les récupérer : dégel de ${c.unfreezeDelayDays} jour${c.unfreezeDelayDays > 1 ? 's' : ''}.`;
        case 'unfreeze':
          return `Tu dégèles ${amt(x.amount, TRX)} (${x.resource === 'ENERGY' ? 'énergie' : 'bande passante'}) : disponibles dans ${c.unfreezeDelayDays} jour${c.unfreezeDelayDays > 1 ? 's' : ''}, puis à retirer.`;
        case 'withdrawUnfrozen':
          return `Tu récupères ${amt(c.withdrawableNow, TRX)} dégelés sur ton solde.`;
        case 'cancelAllUnfreeze':
          return 'Tu annules tous tes dégels en cours : les TRX sont re-stakés (ceux arrivés à terme sont retirés).';
        case 'claimRewards':
          return `Tu réclames ${amt(c.reward, TRX)} de récompenses de vote (une fois par 24 h).`;
        case 'vote':
          return `Tu votes ${x.total} voix pour ${x.votes.length} SR. Ces votes remplacent tous tes votes actuels.`;
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
              return <Row key={v.address} k={`${v.count} voix`} v={`${w?.url ?? shortAddress(v.address)} (déclaré) · rang ${w?.rank ?? '?'} · garde ${w?.brokerage ?? '?'} %`} {...(warn ? { tone: 'warn' as const } : {})} />;
            })}
          {(x.type === 'freeze' || x.type === 'unfreeze') && <Row k="Ressource" v={x.resource === 'ENERGY' ? 'énergie' : 'bande passante'} />}
          {(x.type === 'freeze' || x.type === 'unfreeze') && <Row k="Délai de dégel du réseau" v={`${c.account.unfreezeDelayDays} jour${c.account.unfreezeDelayDays > 1 ? 's' : ''}`} />}
          <Row k="TRON Power" v={`${c.account.tronPowerUsed} / ${c.account.tronPowerLimit} voté avant l’opération`} {...(c.warnings.some((k) => k.kind === 'votesReduced') ? { tone: 'warn' as const } : {})} />
          <Row k="Bande passante" v={`${c.estimate.bandwidthNeeded} octets · ${BigInt(c.estimate.bandwidthBurn) > 0n ? `${amt(c.estimate.bandwidthBurn, TRX)} brûlés` : 'couverte, rien de brûlé'}`} />
          <Row k="Expire" v={fmtWhen(b.summary.expiration)} />
          <Row k="ID" v={<span className="font-mono text-[11px]">{shortAddress(b.txid, 10, 8)}</span>} />
          <Row k="Risque" v="pas de slashing ; récompenses selon le SR" />
        </>
      );
    },
    warnings: (b) => b.context.warnings.map((w) => tronWarningText(w, b.context.witnesses)),
    sign: async (b, password) => ({ ...(await call('tron_stake_sign', { raw: b.raw, password, ...acct('tron') })), raw: b.raw }),
    broadcast: (s) => call('tron_broadcast', { raw: s.raw, signature: s.signature, ...acct('tron') }),
    doneText: 'Transaction TRON diffusée. L’aperçu est relu aussitôt ; s’il n’a pas encore changé, le bloc arrive dans quelques secondes.',
  };
  return <StakeFlowDialog spec={spec} onClose={onClose} onDone={onDone} />;
}
