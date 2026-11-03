// SPDX-License-Identifier: GPL-3.0-or-later
// Earn (docs/IPC.md §2.8): one list of options (staking, liquid staking, lending). Solana, Cardano,
// TRON and NEAR open their staking tab; Lido and Aave v3 (Ethereum) run a short flow here:
// amount → review → confirm. Rust builds the call (`earn_evm_build`) and names it in the native window.

import { useMemo, useState } from 'react';
import { call, toIpcError, type EarnEvmAction, type HwDeviceKind } from '@kyro/shared';
import { signAndBroadcastHw, tryParseUnits, type AssetDef, type EvmAdapter } from '@kyro/chains';
import { buildApproval, buildRevoke, requiresZeroAllowanceFirst } from '@kyro/swap';
import { useApp, useVault } from '../state/app';
import { useCachedAsync } from '../lib/useAsync';
import { useOnTorReady } from '../state/tor';
import { fmtCrypto, fmtPct, sanitizeDecimalInput, toInputDecimal } from '../lib/format';
import { AAVE_MARKETS, EARN_OPTIONS, LIDO_QUEUE, LIDO_STETH, SEL_GET_WITHDRAWAL_REQUESTS, parseUintArray, parseWithdrawalStatus, withdrawalStatusCall, type WithdrawalStatus, SEL_BALANCE_OF, SEL_GET_RESERVE_DATA, aaveApyPercent, addrArg, earnBlock, filterOptions, lidoAprPercent, parseReserveData, parseUint, type EarnFilter, type EarnOption } from '../lib/earn';
import { CoinIcon, HIDDEN, PasswordField } from '../components/kit';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Input, Notice, Segmented, Spinner } from '../components/ui/primitives';
import { IconCheck, IconShield, IconWarn } from '../components/icons';
import { idx } from '../components/motion';
import { useT } from '../i18n';
import { BRAND, hwErrorView, pickDevice, withDevice } from '../state/hw';

type Hex = `0x${string}`;
type Rates = Record<string, number | null>;
type Positions = Record<string, bigint>;

type EvmGet = (chainKey: string) => EvmAdapter | undefined;

/** A rate that is not in after this long shows « — » (demo, testnet, a slow or failed read). */
const RATE_TIMEOUT_MS = 6_000;

function settle(job: Promise<void>): Promise<void> {
  return Promise.race([job, new Promise<void>((r) => window.setTimeout(r, RATE_TIMEOUT_MS))]);
}

async function readRates(evm: EvmGet): Promise<Rates> {
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
    call('earn_staking_rates').then(
      (v) => void Object.assign(out, { sol: v.sol, ada: v.ada, trx: v.trx }),
      () => undefined,
    ),
  ];
  for (const [id, m] of Object.entries(AAVE_MARKETS)) {
    const a = evm(m.chainKey);
    if (!a) continue;
    jobs.push(
      a.client
        .call({ to: m.pool as Hex, data: `${SEL_GET_RESERVE_DATA}${addrArg(m.asset)}` as Hex })
        .then(({ data }) => {
          const d = parseReserveData(data ?? '0x');
          // Pinning check: the pool must report the aToken Kyro expects.
          out[id] = d.aToken === m.aToken ? aaveApyPercent(d.liquidityRate) : null;
        })
        .catch(() => void (out[id] = null)),
    );
  }
  await Promise.all(jobs.map(settle));
  // Every option gets an answer: a missing rate is « — », never an endless spinner.
  const done: Rates = {};
  for (const o of EARN_OPTIONS) done[o.id] = out[o.id] ?? null;
  return done;
}

async function tokenBalance(eth: EvmAdapter, token: string): Promise<bigint> {
  const { data } = await eth.client.call({ to: token as Hex, data: `${SEL_BALANCE_OF}${addrArg(eth.getAddress())}` as Hex });
  return parseUint(data);
}

async function readLidoRequests(eth: EvmAdapter): Promise<WithdrawalStatus[]> {
  const { data } = await eth.client.call({ to: LIDO_QUEUE as Hex, data: `${SEL_GET_WITHDRAWAL_REQUESTS}${addrArg(eth.getAddress())}` as Hex });
  const ids = parseUintArray(data ?? '0x').slice(-50);
  if (!ids.length) return [];
  const st = await eth.client.call({ to: LIDO_QUEUE as Hex, data: withdrawalStatusCall(ids) as Hex });
  return parseWithdrawalStatus(st.data ?? '0x', ids).filter((r) => !r.isClaimed);
}

async function readPositions(evm: EvmGet): Promise<Positions> {
  const out: Positions = {};
  const eth = evm('ethereum');
  const jobs: Promise<unknown>[] = eth ? [tokenBalance(eth, LIDO_STETH).then((v) => (out['eth-lido'] = v))] : [];
  for (const [id, m] of Object.entries(AAVE_MARKETS)) {
    const a = evm(m.chainKey);
    if (a) jobs.push(tokenBalance(a, m.aToken).then((v) => (out[id] = v), () => undefined));
  }
  await Promise.all(jobs);
  return out;
}

export function Earn() {
  const { navigate, network, activeHw, hideBalances } = useApp();
  const { adapters, accounts } = useVault();
  const { t } = useT();
  const [filter, setFilter] = useState<EarnFilter>('all');
  const [flow, setFlow] = useState<{ opt: EarnOption; mode: Mode } | null>(null);
  const evm: EvmGet = (k) => (network === 'mainnet' ? adapters.evm.get(k) : undefined);
  const eth = evm('ethereum');
  const ethKey = eth?.getAddress() ?? '-';
  const rates = useCachedAsync<Rates>(`earn.rates.${network}`, () => readRates(evm), [network, !!eth], { intervalMs: 300_000 });
  const pos = useCachedAsync<Positions>(eth ? `earn.pos.${ethKey}` : null, eth ? () => readPositions(evm) : null, [ethKey]);
  const lidoReq = useCachedAsync<WithdrawalStatus[]>(eth ? `earn.lidoq.${ethKey}` : null, eth ? () => readLidoRequests(eth) : null, [ethKey]);
  const claimable = (lidoReq.data ?? []).filter((r) => r.isFinalized);
  const pending = (lidoReq.data ?? []).filter((r) => !r.isFinalized).reduce((a, r) => a + r.amountOfStETH, 0n);
  useOnTorReady(() => {
    rates.reload();
    pos.reload();
    lidoReq.reload();
  });
  const has: Record<string, boolean> = { sol: !!accounts.sol, ada: !!accounts.cardano, tron: !!accounts.tron, near: !!accounts.near };
  const typeLabel = { staking: t('earn.typeStaking'), liquid: t('earn.typeLiquid'), lending: t('earn.typeLending') } as const;
  const list = filterOptions(EARN_OPTIONS, filter);

  const adapterFor = (o: EarnOption): EvmAdapter | undefined => (o.target.kind === 'aave' ? evm(AAVE_MARKETS[o.target.market]!.chainKey) : o.target.kind === 'lido' ? eth : undefined);
  const unavailable = (o: EarnOption): string | null => {
    const b = earnBlock(o, { hw: !!activeHw, hasAccount: (c) => !!has[c], hasEvm: !!adapterFor(o) });
    return b ? t(`earn.${b}` as const) : null;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 pt-7 pb-6 scroll-thin [&>*]:shrink-0">
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
                <div className="text-[22px] font-semibold tracking-[-0.02em] text-up tabular-nums">{apy === undefined && !rates.error ? <Spinner /> : fmtPct(apy, { decimals: 2, sign: false })}</div>
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
                {o.target.kind === 'lido' && claimable.length > 0 && (
                  <Button variant="outline" size="sm" disabled={!!why} onClick={() => setFlow({ opt: o, mode: 'claim' })}>
                    {t('earn.claim', { amount: fmtCrypto(claimable.reduce((a, r) => a + r.amountOfStETH, 0n), 18, 'ETH', 4) })}
                  </Button>
                )}
                {position && o.target.kind !== 'tab' && (
                  <Button variant="outline" size="sm" disabled={!!why} onClick={() => setFlow({ opt: o, mode: 'out' })}>
                    {o.target.kind === 'lido' ? t('earn.unstake') : t('earn.withdraw')}
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
      {pending > 0n && <p className="m-0 px-1 text-[12.5px] text-mute">{t('earn.pending', { amount: fmtCrypto(pending, 18, 'stETH', 4) })} · {t('earn.queueNote')}</p>}
      <p className="m-0 flex items-start gap-2.5 px-1 text-[13px] leading-[1.55] text-mute">
        <IconShield size={16} className="mt-0.5 shrink-0 text-ice" />
        <span>{t('earn.risk')}</span>
      </p>
      {flow && adapterFor(flow.opt) && (
        <EvmEarnDialog
          opt={flow.opt}
          mode={flow.mode}
          eth={adapterFor(flow.opt)!}
          hw={activeHw?.device ?? null}
          apy={rates.data?.[flow.opt.id] ?? null}
          position={pos.data?.[flow.opt.id] ?? 0n}
          onClose={() => setFlow(null)}
          claims={claimable}
          onDone={() => {
            pos.reload();
            lidoReq.reload();
          }}
        />
      )}
    </div>
  );
}

type Phase = 'amount' | 'review' | 'busy' | 'done';
type Mode = 'in' | 'out' | 'claim';

function EvmEarnDialog({ opt, mode, eth, hw, apy, position, claims, onClose, onDone }: { opt: EarnOption; mode: Mode; eth: EvmAdapter; hw: HwDeviceKind | null; apy: number | null; position: bigint; claims: WithdrawalStatus[]; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const { network } = useApp();
  const [input, setInput] = useState('');
  const [all, setAll] = useState(false);
  const [phase, setPhase] = useState<Phase>(mode === 'claim' ? 'review' : 'amount');
  const [step, setStep] = useState('');
  const [password, setPassword] = useState('');
  const [wrongPw, setWrongPw] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [blindHint, setBlindHint] = useState(false);
  const isLido = opt.target.kind === 'lido';
  const reserve = opt.target.kind === 'aave' ? AAVE_MARKETS[opt.target.market]! : null;
  const aave = reserve?.symbol ?? null;
  const chainId = reserve?.chainId ?? 1;
  const pool = reserve?.pool ?? '';
  const balance = useCachedAsync<bigint>(`earn.bal.${opt.id}.${eth.getAddress()}`, () =>
    mode === 'out' ? Promise.resolve(position) : isLido ? eth.client.getBalance({ address: eth.getAddress() as Hex }) : tokenBalance(eth, reserve!.asset),
  [opt.id, mode]);
  const claimTotal = claims.reduce((a, r) => a + r.amountOfStETH, 0n);
  const amount = useMemo(() => (mode === 'claim' ? claimTotal : all ? position : tryParseUnits(input, opt.decimals)), [mode, claimTotal, all, input, opt.decimals, position]);
  const over = amount !== null && balance.data !== undefined && amount > balance.data;
  const unit = (v: bigint) => fmtCrypto(v, opt.decimals, opt.symbol, opt.decimals);
  const action: EarnEvmAction | null =
    amount === null || amount <= 0n ? null : mode === 'claim' ? { kind: 'lidoClaim', requestId: '0' } : isLido ? (mode === 'in' ? { kind: 'lidoStake', amount: amount.toString() } : { kind: 'lidoRequestWithdrawal', amount: amount.toString() }) : mode === 'in' ? { kind: 'aaveSupply', asset: aave!, amount: amount.toString(), chainId } : all ? { kind: 'aaveWithdraw', asset: aave!, chainId } : { kind: 'aaveWithdraw', asset: aave!, amount: amount.toString(), chainId };
  const title = mode === 'claim' ? t('earn.claimTitle') : isLido ? t(mode === 'in' ? 'earn.stakeTitle' : 'earn.unstakeTitle', { symbol: opt.symbol }) : t(mode === 'in' ? 'earn.supplyTitle' : 'earn.withdrawTitle', { symbol: opt.symbol });
  const target = isLido ? (mode === 'in' ? LIDO_STETH : LIDO_QUEUE) : pool;
  const contract = isLido ? (mode === 'in' ? `Lido stETH · ${LIDO_STETH}` : `Lido Withdrawal Queue · ${LIDO_QUEUE}`) : `Aave v3 Pool · ${pool}`;
  const fn = mode === 'claim' ? 'claimWithdrawal' : isLido ? (mode === 'in' ? 'submit' : 'requestWithdrawals') : mode === 'in' ? 'supply' : 'withdraw';
  const asset: AssetDef = { id: isLido ? 'evm:1' : `erc20:${chainId}:${reserve!.asset}`, chainKey: reserve?.chainKey ?? 'ethereum', family: 'evm', kind: isLido ? 'native' : 'erc20', symbol: opt.symbol, name: opt.name, decimals: opt.decimals, ...(isLido ? {} : { contract: reserve!.asset }) } as AssetDef;

  const run = async () => {
    if (!action || amount === null) return;
    setPhase('busy');
    setError(null);
    setBlindHint(false);
    try {
      // Hardware wallet: Rust shows its decoded review (pinned contract + function), then the device.
      const device = hw ? await pickDevice(hw) : null;
      const sign = async (u: Awaited<ReturnType<EvmAdapter['buildCall']>>) =>
        device ? withDevice(device.id, () => signAndBroadcastHw(eth, u, device.id)) : eth.broadcast(await eth.signTx(u, password));
      const fee = (await eth.estimateFees()).options.normal.params;
      if (fee.family !== 'evm') throw new Error('fee');
      const send = async (to: string, data: Hex, value: bigint, kind: 'approval' | 'swap') => {
        const u = await eth.buildCall({ to, data, value, fee, kind, asset, amount: kind === 'approval' ? amount : value });
        const h = await sign(u);
        setStep(t('earn.stepWaiting'));
        if (!(await eth.waitForReceipt(h))) throw new Error(t('earn.errFailed'));
      };
      if (mode === 'claim') {
        for (const r of claims) {
          setStep(t('earn.stepSending'));
          const b = await call('earn_evm_build', { action: { kind: 'lidoClaim', requestId: r.id.toString() }, ...(eth.account ? { account: eth.account } : {}) });
          await send(b.to, b.data as Hex, 0n, 'swap');
        }
        setPhase('done');
        onDone();
        return;
      }
      if (isLido && mode === 'out') {
        const current = await eth.allowance(LIDO_STETH, LIDO_QUEUE);
        if (current < amount) {
          setStep(t('earn.stepApproving'));
          const ap = buildApproval({ token: LIDO_STETH, spender: LIDO_QUEUE, amount });
          await send(ap.to, ap.data, 0n, 'approval');
        }
      }
      if (aave && mode === 'in') {
        const current = await eth.allowance(reserve!.asset, pool);
        if (current < amount) {
          setStep(t('earn.stepApproving'));
          if (requiresZeroAllowanceFirst(chainId, reserve!.asset, current)) {
            const r = buildRevoke(reserve!.asset, pool);
            await send(r.to, r.data, 0n, 'approval');
          }
          const ap = buildApproval({ token: reserve!.asset, spender: pool, amount });
          await send(ap.to, ap.data, 0n, 'approval');
        }
      }
      setStep(t('earn.stepSending'));
      const built = await call('earn_evm_build', { action, ...(eth.account ? { account: eth.account } : {}) });
      const value = BigInt(built.valueWei);
      const u = await eth.buildCall({ to: built.to, data: built.data as Hex, value, fee, kind: 'swap', asset, amount });
      const decoded = await eth.decode(u);
      if (decoded.to.toLowerCase() !== target || BigInt(decoded.valueWei) !== (isLido && mode === 'in' ? amount : 0n)) throw new Error(t('earn.errDecode'));
      const h = await sign(u);
      setStep(t('earn.stepWaiting'));
      if (!(await eth.waitForReceipt(h))) throw new Error(t('earn.errFailed'));
      setPhase('done');
      onDone();
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrongPw((n) => n + 1);
      // Ledger answers 6A80 when blind signing is off: a short hint (Kyro already named the call).
      setBlindHint(hw === 'ledger' && err.code === 'HW_UNSUPPORTED');
      setError(hw && err.code.startsWith('HW_') ? hwErrorView(e).detail : err.message);
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
          {hw ? (
            <p className="m-0 text-[12.5px] text-mute">{t('earn.hwSign', { device: BRAND[hw] })}</p>
          ) : (
            <PasswordField id="earn-pw" value={password} onChange={setPassword} wrong={wrongPw} onEnter={() => password && phase === 'review' && void run()} />
          )}
          {blindHint && <p className="m-0 text-[12.5px] font-medium text-warn">{t('earn.hwBlind')}</p>}
          {error && (
            <div className="flex items-start gap-2 text-[12.5px] text-warn">
              <IconWarn size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={phase === 'busy'} onClick={() => setPhase('amount')}>
              {t('earn.back')}
            </Button>
            <Button disabled={(!hw && !password) || phase === 'busy' || network !== 'mainnet'} onClick={() => void run()}>
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
