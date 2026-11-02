// SPDX-License-Identifier: GPL-3.0-or-later
// Earn (docs/IPC.md §2.8): one list of options (staking, liquid staking, lending). Solana, Cardano,
// TRON and NEAR open their staking tab; Lido and Aave v3 (Ethereum) run a short flow here:
// amount → review → confirm. Rust builds the call (`earn_evm_build`) and names it in the native window.

import { useMemo, useState } from 'react';
import { call, toIpcError, type EarnEvmAction } from '@kyro/shared';
import { tryParseUnits, type AssetDef, type EvmAdapter } from '@kyro/chains';
import { buildApproval, buildRevoke, requiresZeroAllowanceFirst } from '@kyro/swap';
import { useApp, useVault } from '../state/app';
import { useCachedAsync } from '../lib/useAsync';
import { useOnTorReady } from '../state/tor';
import { fmtCrypto, fmtPct, sanitizeDecimalInput, toInputDecimal } from '../lib/format';
import { AAVE_POOL, AAVE_RESERVES, EARN_OPTIONS, LIDO_STETH, SEL_BALANCE_OF, SEL_GET_RESERVE_DATA, aaveApyPercent, addrArg, filterOptions, lidoAprPercent, parseReserveData, parseUint, type AaveAsset, type EarnFilter, type EarnOption } from '../lib/earn';
import { CoinIcon, HIDDEN, PasswordField } from '../components/kit';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Input, Notice, Segmented, Spinner } from '../components/ui/primitives';
import { IconCheck, IconShield, IconWarn } from '../components/icons';
import { idx } from '../components/motion';
import { useT } from '../i18n';

type Hex = `0x${string}`;
type Rates = Record<string, number | null>;
type Positions = Record<string, bigint>;

async function readRates(eth: EvmAdapter | undefined): Promise<Rates> {
  const out: Rates = {};
  const jobs: Promise<void>[] = [
    lidoAprPercent().then(
      (v) => void (out['eth-lido'] = v),
      () => void (out['eth-lido'] = null),
    ),
    call('near_stake_validators').then(
      (v) => void (out.near = v.grossApy),
      () => void (out.near = null),
    ),
  ];
  if (eth) {
    for (const [sym, r] of Object.entries(AAVE_RESERVES) as [AaveAsset, (typeof AAVE_RESERVES)[AaveAsset]][]) {
      jobs.push(
        eth.client
          .call({ to: AAVE_POOL as Hex, data: `${SEL_GET_RESERVE_DATA}${addrArg(r.asset)}` as Hex })
          .then(({ data }) => {
            const d = parseReserveData(data ?? '0x');
            // Pinning check: the pool must report the aToken Kyro expects.
            out[`${sym.toLowerCase()}-aave`] = d.aToken === r.aToken ? aaveApyPercent(d.liquidityRate) : null;
          })
          .catch(() => void (out[`${sym.toLowerCase()}-aave`] = null)),
      );
    }
  }
  await Promise.all(jobs);
  return out;
}

async function tokenBalance(eth: EvmAdapter, token: string): Promise<bigint> {
  const { data } = await eth.client.call({ to: token as Hex, data: `${SEL_BALANCE_OF}${addrArg(eth.getAddress())}` as Hex });
  return parseUint(data);
}

async function readPositions(eth: EvmAdapter): Promise<Positions> {
  const bal = (token: string) => tokenBalance(eth, token);
  const entries = await Promise.all([
    bal(LIDO_STETH).then((v) => ['eth-lido', v] as const),
    ...(Object.entries(AAVE_RESERVES) as [AaveAsset, (typeof AAVE_RESERVES)[AaveAsset]][]).map(([sym, r]) => bal(r.aToken).then((v) => [`${sym.toLowerCase()}-aave`, v] as const)),
  ]);
  return Object.fromEntries(entries);
}

export function Earn() {
  const { navigate, network, activeHw, hideBalances } = useApp();
  const { adapters, accounts } = useVault();
  const { t } = useT();
  const [filter, setFilter] = useState<EarnFilter>('all');
  const [flow, setFlow] = useState<{ opt: EarnOption; mode: 'in' | 'out' } | null>(null);
  const eth = network === 'mainnet' ? adapters.evm.get('ethereum') : undefined;
  const ethKey = eth?.getAddress() ?? '-';
  const rates = useCachedAsync<Rates>(`earn.rates.${network}`, () => readRates(eth), [network, !!eth], { intervalMs: 300_000 });
  const pos = useCachedAsync<Positions>(eth && !activeHw ? `earn.pos.${ethKey}` : null, eth && !activeHw ? () => readPositions(eth) : null, [ethKey, !!activeHw]);
  useOnTorReady(() => {
    rates.reload();
    pos.reload();
  });
  const has: Record<string, boolean> = { sol: !!accounts.sol, ada: !!accounts.cardano, tron: !!accounts.tron, near: !!accounts.near };
  const typeLabel = { staking: t('earn.typeStaking'), liquid: t('earn.typeLiquid'), lending: t('earn.typeLending') } as const;
  const list = filterOptions(EARN_OPTIONS, filter);

  const unavailable = (o: EarnOption): string | null => {
    if (o.target.kind === 'tab') return activeHw ? t('earn.hw') : has[o.target.chain] ? null : t('earn.noAccount');
    if (activeHw) return t('earn.hw');
    return eth ? null : t('earn.mainnetOnly');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 pt-7 pb-6 scroll-thin">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="screen-title">{t('earn.title')}</h1>
          <p className="m-0 mt-1 text-[13px] text-mute">{t('earn.subtitle')}</p>
        </div>
        <Segmented
          label={t('earn.title')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('earn.filterAll') },
            { value: 'staking', label: t('earn.filterStaking') },
            { value: 'stable', label: t('earn.filterStable') },
          ]}
        />
      </header>

      <div className="flex flex-col divide-y divide-line overflow-hidden rounded-panel border border-line bg-card">
        {list.map((o, i) => {
          const why = unavailable(o);
          const apy = rates.data?.[o.id];
          const p = pos.data?.[o.id];
          const position = p !== undefined && p > 0n ? (hideBalances ? HIDDEN : fmtCrypto(p, o.decimals, o.target.kind === 'lido' ? 'stETH' : o.symbol, 6)) : null;
          const start = () => (o.target.kind === 'tab' ? navigate({ name: 'staking', chain: o.target.chain }) : setFlow({ opt: o, mode: 'in' }));
          return (
            <div key={o.id} className="rise grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_auto] items-center gap-4 px-5 py-3.5" style={idx(i)}>
              <div className="flex min-w-0 items-center gap-3">
                <CoinIcon symbol={o.symbol} size={34} />
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">{o.name}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[12px] text-mute">
                    <Badge>{typeLabel[o.type]}</Badge>
                    {position && (
                      <span className="truncate text-text2">
                        {t('earn.position')} · <strong className="font-semibold text-text">{position}</strong>
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[22px] font-semibold tracking-[-0.02em] text-up tabular-nums">{apy === undefined ? <Spinner /> : fmtPct(apy, { decimals: 2, sign: false })}</div>
                <div className="text-[11.5px] text-mute">{t('earn.est')}</div>
              </div>
              <div className="text-[13px]">
                <div className="text-mute text-[11.5px]">{t('earn.lock')}</div>
                {t(o.lockKey)}
              </div>
              <div className="text-[13px]">
                <div className="text-mute text-[11.5px]">{t('earn.min')}</div>
                {o.min ?? t('earn.none')}
              </div>
              <div className="flex items-center justify-end gap-2" title={why ?? undefined}>
                {position && o.target.kind === 'aave' && (
                  <Button variant="outline" size="sm" disabled={!!why} onClick={() => setFlow({ opt: o, mode: 'out' })}>
                    {t('earn.withdraw')}
                  </Button>
                )}
                <Button size="sm" disabled={!!why} onClick={start}>
                  {o.target.kind === 'tab' ? t('earn.manage') : t('earn.start')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {pos.data?.['eth-lido'] ? <p className="m-0 px-1 text-[12.5px] text-mute">{t('earn.lidoUnstake')}</p> : null}
      <p className="m-0 flex items-start gap-2.5 px-1 text-[13px] leading-[1.55] text-mute">
        <IconShield size={16} className="mt-0.5 shrink-0 text-ice" />
        <span>{t('earn.risk')}</span>
      </p>
      {flow && eth && (
        <EvmEarnDialog
          opt={flow.opt}
          mode={flow.mode}
          eth={eth}
          apy={rates.data?.[flow.opt.id] ?? null}
          position={pos.data?.[flow.opt.id] ?? 0n}
          onClose={() => setFlow(null)}
          onDone={() => pos.reload()}
        />
      )}
    </div>
  );
}

type Phase = 'amount' | 'review' | 'busy' | 'done';

function EvmEarnDialog({ opt, mode, eth, apy, position, onClose, onDone }: { opt: EarnOption; mode: 'in' | 'out'; eth: EvmAdapter; apy: number | null; position: bigint; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const { network } = useApp();
  const [input, setInput] = useState('');
  const [all, setAll] = useState(false);
  const [phase, setPhase] = useState<Phase>('amount');
  const [step, setStep] = useState('');
  const [password, setPassword] = useState('');
  const [wrongPw, setWrongPw] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const isLido = opt.target.kind === 'lido';
  const aave = opt.target.kind === 'aave' ? opt.target.asset : null;
  const reserve = aave ? AAVE_RESERVES[aave] : null;
  const balance = useCachedAsync<bigint>(`earn.bal.${opt.id}.${eth.getAddress()}`, () =>
    mode === 'out' ? Promise.resolve(position) : isLido ? eth.client.getBalance({ address: eth.getAddress() as Hex }) : tokenBalance(eth, reserve!.asset),
  [opt.id, mode]);
  const amount = useMemo(() => (all ? position : tryParseUnits(input, opt.decimals)), [all, input, opt.decimals, position]);
  const over = amount !== null && balance.data !== undefined && amount > balance.data;
  const unit = (v: bigint) => fmtCrypto(v, opt.decimals, opt.symbol, opt.decimals);
  const action: EarnEvmAction | null =
    amount === null || amount <= 0n ? null : isLido ? { kind: 'lidoStake', amount: amount.toString() } : mode === 'in' ? { kind: 'aaveSupply', asset: aave!, amount: amount.toString() } : all ? { kind: 'aaveWithdraw', asset: aave! } : { kind: 'aaveWithdraw', asset: aave!, amount: amount.toString() };
  const title = isLido ? t('earn.stakeTitle', { symbol: opt.symbol }) : t(mode === 'in' ? 'earn.supplyTitle' : 'earn.withdrawTitle', { symbol: opt.symbol });
  const contract = isLido ? `Lido stETH · ${LIDO_STETH}` : `Aave v3 Pool · ${AAVE_POOL}`;
  const fn = isLido ? 'submit' : mode === 'in' ? 'supply' : 'withdraw';
  const asset: AssetDef = { id: isLido ? 'evm:1' : `erc20:1:${reserve!.asset.toLowerCase()}`, chainKey: 'ethereum', family: 'evm', kind: isLido ? 'native' : 'erc20', symbol: opt.symbol, name: opt.name, decimals: opt.decimals, ...(isLido ? {} : { contract: reserve!.asset }) } as AssetDef;

  const run = async () => {
    if (!action || amount === null) return;
    setPhase('busy');
    setError(null);
    try {
      const fee = (await eth.estimateFees()).options.normal.params;
      if (fee.family !== 'evm') throw new Error('fee');
      const send = async (to: string, data: Hex, value: bigint, kind: 'approval' | 'swap') => {
        const u = await eth.buildCall({ to, data, value, fee, kind, asset, amount: kind === 'approval' ? amount : value });
        const h = await eth.broadcast(await eth.signTx(u, password));
        setStep(t('earn.stepWaiting'));
        if (!(await eth.waitForReceipt(h))) throw new Error(t('earn.errFailed'));
      };
      if (aave && mode === 'in') {
        const current = await eth.allowance(reserve!.asset, AAVE_POOL);
        if (current < amount) {
          setStep(t('earn.stepApproving'));
          if (requiresZeroAllowanceFirst(1, reserve!.asset, current)) {
            const r = buildRevoke(reserve!.asset, AAVE_POOL);
            await send(r.to, r.data, 0n, 'approval');
          }
          const ap = buildApproval({ token: reserve!.asset, spender: AAVE_POOL, amount });
          await send(ap.to, ap.data, 0n, 'approval');
        }
      }
      setStep(t('earn.stepSending'));
      const built = await call('earn_evm_build', { action, ...(eth.account ? { account: eth.account } : {}) });
      const value = BigInt(built.valueWei);
      const u = await eth.buildCall({ to: built.to, data: built.data as Hex, value, fee, kind: 'swap', asset, amount });
      const decoded = await eth.decode(u);
      if (decoded.to.toLowerCase() !== (isLido ? LIDO_STETH : AAVE_POOL) || BigInt(decoded.valueWei) !== (isLido ? amount : 0n)) throw new Error(t('earn.errDecode'));
      const h = await eth.broadcast(await eth.signTx(u, password));
      setStep(t('earn.stepWaiting'));
      if (!(await eth.waitForReceipt(h))) throw new Error(t('earn.errFailed'));
      setPhase('done');
      onDone();
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrongPw((n) => n + 1);
      setError(err.message);
      setPhase('review');
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && phase !== 'busy' && onClose()} title={title} dismissable={phase !== 'busy'}>
      {phase === 'amount' && (
        <div className="flex flex-col gap-3">
          <label className="text-[12.5px] text-mute" htmlFor="earn-amt">
            {t('earn.amount')}
          </label>
          <div className="flex gap-2">
            <Input id="earn-amt" inputMode="decimal" value={all ? t('earn.all') : input} disabled={all} onChange={(e) => setInput(sanitizeDecimalInput(e.target.value, opt.decimals))} placeholder="0" />
            {mode === 'out' ? (
              <Button variant="outline" onClick={() => setAll((v) => !v)}>
                {all ? t('earn.back') : t('earn.all')}
              </Button>
            ) : (
              <Button variant="outline" disabled={balance.data === undefined || isLido} onClick={() => balance.data !== undefined && setInput(toInputDecimal(balance.data, opt.decimals))}>
                {t('earn.max')}
              </Button>
            )}
          </div>
          <div className="text-[12.5px] text-mute">{t('earn.available', { amount: balance.data === undefined ? '—' : unit(balance.data) })}</div>
          {over && <div className="text-[12.5px] text-warn">{t('earn.over')}</div>}
          <Button disabled={!action || over} onClick={() => setPhase('review')}>
            {t('earn.next')}
          </Button>
        </div>
      )}
      {(phase === 'review' || phase === 'busy') && amount !== null && (
        <div className="flex flex-col gap-3 text-[13px]">
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-mute">{t('earn.contract')}</dt>
            <dd className="m-0 break-all font-mono text-[12px]">{contract}</dd>
            <dt className="text-mute">{t('earn.function')}</dt>
            <dd className="m-0 font-mono">{fn}</dd>
            <dt className="text-mute">{mode === 'in' ? t('earn.youSend') : t('earn.youGet')}</dt>
            <dd className="m-0 font-semibold">{all ? `${t('earn.all')} (${unit(position)})` : unit(amount)}</dd>
            {isLido && (
              <>
                <dt className="text-mute">{t('earn.youGet')}</dt>
                <dd className="m-0">≈ {fmtCrypto(amount, 18, 'stETH', 6)}</dd>
              </>
            )}
            {aave && mode === 'in' && (
              <>
                <dt className="text-mute">{t('earn.approval')}</dt>
                <dd className="m-0">{t('earn.approvalExact', { amount: unit(amount) })} → Aave v3 Pool</dd>
              </>
            )}
            {mode === 'in' && (
              <>
                <dt className="text-mute">{t('earn.estApy')}</dt>
                <dd className="m-0 text-up">{fmtPct(apy, { decimals: 2, sign: false })}</dd>
              </>
            )}
          </dl>
          <Notice tone="info" icon={<IconShield size={15} className="mt-0.5 shrink-0 text-ice" />}>
            {t('earn.risk')}
          </Notice>
          <PasswordField id="earn-pw" value={password} onChange={setPassword} wrong={wrongPw} onEnter={() => password && phase === 'review' && void run()} />
          {error && (
            <div className="flex items-start gap-2 text-[12.5px] text-warn">
              <IconWarn size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={phase === 'busy'} onClick={() => setPhase('amount')}>
              {t('earn.back')}
            </Button>
            <Button disabled={!password || phase === 'busy' || network !== 'mainnet'} onClick={() => void run()}>
              {phase === 'busy' ? (
                <>
                  <Spinner /> {step}
                </>
              ) : (
                t('earn.confirm')
              )}
            </Button>
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <IconCheck size={28} className="text-up" />
          <div className="text-[16px] font-semibold">{t('earn.done')}</div>
          <p className="m-0 text-[13px] text-mute">{t('earn.doneBody')}</p>
          <Button onClick={onClose}>{t('earn.close')}</Button>
        </div>
      )}
    </Dialog>
  );
}
