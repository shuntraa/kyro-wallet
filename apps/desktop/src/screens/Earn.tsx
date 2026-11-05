// SPDX-License-Identifier: GPL-3.0-or-later
// Earn (docs/IPC.md §2.8): one list of options (staking, liquid staking, lending). Solana, Cardano,
// TRON, NEAR, Sui and Aptos open their staking tab; Lido and Aave v3 (Ethereum) run a short flow here:
// amount → review → confirm. Rust builds the call (`earn_evm_build`) and names it in the native window.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, toIpcError, type EarnEvmAction, type HwDeviceKind } from '@kyro/shared';
import { signAndBroadcastHw, tryParseUnits, type AssetDef, type EvmAdapter } from '@kyro/chains';
import { buildApproval, buildRevoke, requiresZeroAllowanceFirst } from '@kyro/swap';
import { useApp, useVault } from '../state/app';
import { useAsync, useCachedAsync, useNow } from '../lib/useAsync';
import { useOnTorReady } from '../state/tor';
import { fmtAgo, fmtCrypto, fmtPct, sanitizeDecimalInput, toInputDecimal } from '../lib/format';
import { HW_STAKE, type StakeChain } from '../lib/staking';
import { readJson, writeJson } from '../lib/storage';
import { useStakeOverviews } from '../lib/stakeOverviews';
import { AAVE_MARKETS, EARN_OPTIONS, LIDO_QUEUE, LIDO_STETH, SEL_GET_WITHDRAWAL_REQUESTS, parseUintArray, parseWithdrawalStatus, withdrawalStatusCall, type WithdrawalStatus, SEL_BALANCE_OF, SEL_GET_RESERVE_DATA, aaveApyPercent, addrArg, earnBlock, earnRisk, earnRiskKeys, earnRowName, filterOptions, keepRate, lidoAprPercent, parseReserveData, parseUint, rateIsOld, rateLabelKey, type EarnFilter, type EarnOption, type EarnRisk, type RateStore } from '../lib/earn';
import { MissingFee, useSwapFee } from '../components/MissingFee';
import { SimulationPanel } from '../components/SimulationPanel';
import { CoinIcon, HIDDEN, PasswordField } from '../components/kit';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Input, Notice, Segmented, Spinner } from '../components/ui/primitives';
import { IconCheck, IconShield, IconWarn } from '../components/icons';
import { idx } from '../components/motion';
import { useT } from '../i18n';
import { BRAND, hwErrorView, pickDevice, withDevice } from '../state/hw';

type Hex = `0x${string}`;
type Positions = Record<string, bigint>;

type EvmGet = (chainKey: string) => EvmAdapter | undefined;

/** Reads go through Tor and some servers answer in tens of seconds: past this, the read counts as failed. */
const RATE_TIMEOUT_MS = 90_000;
const RATE_REFRESH_MS = 300_000;

function rateReaders(evm: EvmGet): Record<string, () => Promise<number | null>> {
  const onChain = (chain: 'sol' | 'ada' | 'trx' | 'apt') => () => call('earn_rate', { chain });
  const out: Record<string, () => Promise<number | null>> = {
    'eth-lido': lidoAprPercent,
    near: () => call('near_stake_validators').then((v) => v.grossApy),
    sui: () => call('sui_stake_validators').then((v) => v.networkApy),
    sol: onChain('sol'),
    ada: onChain('ada'),
    trx: onChain('trx'),
    apt: onChain('apt'),
  };
  for (const [id, m] of Object.entries(AAVE_MARKETS)) {
    const a = evm(m.chainKey);
    if (!a) continue;
    out[id] = async () => {
      const { data } = await a.client.call({ to: m.pool as Hex, data: `${SEL_GET_RESERVE_DATA}${addrArg(m.asset)}` as Hex });
      const d = parseReserveData(data ?? '0x');
      // Pinning check: the pool must report the aToken Kyro expects.
      return d.aToken === m.aToken ? aaveApyPercent(d.liquidityRate) : null;
    };
  }
  return out;
}

const orNull = (job: Promise<number | null>): Promise<number | null> =>
  Promise.race([job.catch(() => null), new Promise<null>((r) => window.setTimeout(() => r(null), RATE_TIMEOUT_MS))]);

/** Each rate shows as soon as it is in. The last one read stays on screen, across launches too. */
function useRates(network: string, evm: EvmGet) {
  const key = `earn.rates.${network}`;
  const [store, setStore] = useState<RateStore>(() => readJson<RateStore>(key, {}));
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set(EARN_OPTIONS.map((o) => o.id)));
  const latest = useRef(evm);
  latest.current = evm;
  const alive = useRef(true);
  const reload = useCallback(() => {
    const readers = Object.entries(rateReaders(latest.current));
    setWaiting(new Set(readers.map(([id]) => id)));
    for (const [id, read] of readers) {
      void orNull(read()).then((value) => {
        if (!alive.current) return;
        setStore((s) => {
          const next = keepRate(s, id, value, Date.now());
          if (next !== s) writeJson(key, next);
          return next;
        });
        setWaiting((w) => new Set([...w].filter((x) => x !== id)));
      });
    }
  }, [key]);
  useEffect(() => {
    alive.current = true;
    reload();
    const id = window.setInterval(reload, RATE_REFRESH_MS);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [reload]);
  return { store, waiting, reload };
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
  // One failed read costs that row, not the whole list.
  const jobs: Promise<unknown>[] = eth ? [tokenBalance(eth, LIDO_STETH).then((v) => (out['eth-lido'] = v), () => undefined)] : [];
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
  const [riskOf, setRiskOf] = useState<EarnOption | null>(null);
  const evm: EvmGet = (k) => (network === 'mainnet' ? adapters.evm.get(k) : undefined);
  const eth = evm('ethereum');
  const ethKey = eth?.getAddress() ?? '-';
  const rates = useRates(network, evm);
  const now = useNow(60_000);
  const pos = useCachedAsync<Positions>(eth ? `earn.pos.${ethKey}` : null, eth ? () => readPositions(evm) : null, [ethKey]);
  const lidoReq = useCachedAsync<WithdrawalStatus[]>(eth ? `earn.lidoq.${ethKey}` : null, eth ? () => readLidoRequests(eth) : null, [ethKey]);
  const claimable = (lidoReq.data ?? []).filter((r) => r.isFinalized);
  const pending = (lidoReq.data ?? []).filter((r) => !r.isFinalized).reduce((a, r) => a + r.amountOfStETH, 0n);
  useOnTorReady(() => {
    rates.reload();
    pos.reload();
    lidoReq.reload();
  });
  const has: Record<StakeChain, boolean> = { sol: !!accounts.sol, ada: !!accounts.cardano, tron: !!accounts.tron, near: !!accounts.near, sui: !!accounts.sui, apt: !!accounts.aptos };
  const hwChains: readonly string[] | null = activeHw ? HW_STAKE[activeHw.device] : null;
  const stakes = useStakeOverviews((c) => !!hwChains && !hwChains.includes(c), has);
  const stakedOf = (o: EarnOption): string | null => {
    if (o.target.kind !== 'tab') return null;
    if (o.id === 'ada') {
      const s = stakes.ada.data;
      return s?.stake.registered && s.stake.delegatedPool ? (s.pool?.ticker ?? t('earn.delegated')) : null;
    }
    const v = o.id === 'trx' ? stakes.staked.tron : stakes.staked[o.id as 'sol' | 'near' | 'sui' | 'apt'];
    return v !== undefined && v > 0n ? (hideBalances ? HIDDEN : fmtCrypto(v, o.decimals, o.symbol, 4)) : null;
  };
  const typeLabel = { staking: t('earn.typeStaking'), liquid: t('earn.typeLiquid'), lending: t('earn.typeLending') } as const;
  const list = filterOptions(EARN_OPTIONS, filter);

  const adapterFor = (o: EarnOption): EvmAdapter | undefined => (o.target.kind === 'aave' ? evm(AAVE_MARKETS[o.target.market]!.chainKey) : o.target.kind === 'lido' ? eth : undefined);
  const unavailable = (o: EarnOption): string | null => {
    const b = earnBlock(o, { hw: !!activeHw, hwStake: (c) => !!hwChains?.includes(c), hasAccount: (c) => !!has[c as StakeChain], hasEvm: !!adapterFor(o) });
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
            { value: 'low', label: t('earn.filterLow') },
          ]}
        />
      </header>

      <div className="flex flex-col divide-y divide-line overflow-hidden rounded-panel border border-line bg-card">
        {list.map((o, i) => {
          const why = unavailable(o);
          const rate = rates.store[o.id];
          const p = pos.data?.[o.id];
          const position = stakedOf(o) ?? (p !== undefined && p > 0n ? (hideBalances ? HIDDEN : fmtCrypto(p, o.decimals, o.target.kind === 'lido' ? 'stETH' : o.symbol, 6)) : null);
          const risk = earnRisk(o);
          const row = earnRowName(o);
          const start = () => (o.target.kind === 'tab' ? navigate({ name: 'staking', chain: o.target.chain }) : setFlow({ opt: o, mode: 'in' }));
          return (
            <div key={o.id} className="rise grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.05fr)_minmax(0,0.85fr)_minmax(0,0.7fr)_minmax(0,0.65fr)_auto] items-center gap-4 px-5 py-3.5" style={idx(i)}>
              <div className="flex min-w-0 items-center gap-3">
                <CoinIcon symbol={o.symbol} size={34} />
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">{row.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-mute">
                    <Badge>{typeLabel[o.type]}</Badge>
                    {row.network && <Badge>{row.network}</Badge>}
                  </div>
                  {position && (
                    <div className="mt-1 truncate text-[12px] text-text2">
                      {t('earn.position')} · <strong className="font-semibold text-text">{position}</strong>
                    </div>
                  )}
                </div>
              </div>
              <div>
                <div className="text-[22px] font-semibold tracking-[-0.02em] text-up tabular-nums">{rate ? fmtPct(rate.value, { decimals: 2, sign: false }) : rates.waiting.has(o.id) ? <Spinner /> : '—'}</div>
                <div className="text-[11.5px] text-mute">{rate && rateIsOld(rate, now) ? t('earn.rateOld', { ago: fmtAgo(rate.at, now) }) : t(rateLabelKey(o))}</div>
              </div>
              <div className="text-[13px]">
                <div className="text-mute text-[11.5px]">{t('earn.lock')}</div>
                {t(o.lockKey)}
              </div>
              <div className="text-[13px]">
                <div className="text-mute text-[11.5px]">{t('earn.risk')}</div>
                <button type="button" className="cursor-pointer rounded-full" title={t('earn.riskWhy')} onClick={() => setRiskOf(o)}>
                  <Badge tone={RISK_TONE[risk]}>{t(RISK_LABEL[risk])}</Badge>
                </button>
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
        <span>{t('earn.riskFooter')}</span>
      </p>
      {riskOf && <RiskDialog opt={riskOf} onClose={() => setRiskOf(null)} />}
      {flow && adapterFor(flow.opt) && (
        <EvmEarnDialog
          opt={flow.opt}
          mode={flow.mode}
          eth={adapterFor(flow.opt)!}
          hw={activeHw?.device ?? null}
          apy={rates.store[flow.opt.id]?.value ?? null}
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

const RISK_TONE = { low: 'up', medium: 'warn', high: 'down' } as const satisfies Record<EarnRisk, unknown>;
const RISK_LABEL = { low: 'earn.riskLow', medium: 'earn.riskMedium', high: 'earn.riskHigh' } as const satisfies Record<EarnRisk, unknown>;
const RISK_BODY = { low: 'earn.riskLowBody', medium: 'earn.riskMediumBody', high: 'earn.riskHighBody' } as const satisfies Record<EarnRisk, unknown>;

function RiskList({ opt }: { opt: EarnOption }) {
  const { t } = useT();
  return (
    <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-[1.5] text-text2">
      {earnRiskKeys(opt).map((k) => (
        <li key={k}>{t(k)}</li>
      ))}
    </ul>
  );
}

function RiskDialog({ opt, onClose }: { opt: EarnOption; onClose: () => void }) {
  const { t } = useT();
  const risk = earnRisk(opt);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={opt.name}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] text-text2">
          <Badge tone={RISK_TONE[risk]}>{t(RISK_LABEL[risk])}</Badge>
          <span>{t(RISK_BODY[risk])}</span>
        </div>
        <RiskList opt={opt} />
        <p className="m-0 text-[12.5px] leading-[1.5] text-mute">{t('earn.riskNote')}</p>
        <div className="flex justify-end">
          <Button onClick={onClose}>{t('earn.close')}</Button>
        </div>
      </div>
    </Dialog>
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
  const unit = (v: bigint) => fmtCrypto(v, opt.decimals, opt.symbol, opt.decimals);
  const action: EarnEvmAction | null =
    amount === null || amount <= 0n ? null : mode === 'claim' ? { kind: 'lidoClaim', requestId: '0' } : isLido ? (mode === 'in' ? { kind: 'lidoStake', amount: amount.toString() } : { kind: 'lidoRequestWithdrawal', amount: amount.toString() }) : mode === 'in' ? { kind: 'aaveSupply', asset: aave!, amount: amount.toString(), chainId } : all ? { kind: 'aaveWithdraw', asset: aave!, chainId } : { kind: 'aaveWithdraw', asset: aave!, amount: amount.toString(), chainId };
  const title = mode === 'claim' ? t('earn.claimTitle') : isLido ? t(mode === 'in' ? 'earn.stakeTitle' : 'earn.unstakeTitle', { symbol: opt.symbol }) : t(mode === 'in' ? 'earn.supplyTitle' : 'earn.withdrawTitle', { symbol: opt.symbol });
  const target = isLido ? (mode === 'in' ? LIDO_STETH : LIDO_QUEUE) : pool;
  const contract = isLido ? (mode === 'in' ? `Lido stETH · ${LIDO_STETH}` : `Lido Withdrawal Queue · ${LIDO_QUEUE}`) : `Aave v3 Pool · ${pool}`;
  const fn = mode === 'claim' ? 'claimWithdrawal' : isLido ? (mode === 'in' ? 'submit' : 'requestWithdrawals') : mode === 'in' ? 'supply' : 'withdraw';
  const asset: AssetDef = { id: isLido ? 'evm:1' : `erc20:${chainId}:${reserve!.asset}`, chainKey: reserve?.chainKey ?? 'ethereum', family: 'evm', kind: isLido ? 'native' : 'erc20', symbol: opt.symbol, name: opt.name, decimals: opt.decimals, ...(isLido ? {} : { contract: reserve!.asset }) } as AssetDef;

  const earnFee = useSwapFee(asset);
  // Staking ETH pays its fee from the same coin: the whole balance cannot go in.
  const over = amount !== null && balance.data !== undefined && amount + (isLido && mode === 'in' ? earnFee ?? 0n : 0n) > balance.data;

  // Before the password: what the next signature would do. An approval still to sign goes first,
  // and the call behind it cannot run until then.
  const pinned = isLido ? [LIDO_STETH, LIDO_QUEUE] : [pool, reserve!.asset];
  const review = useAsync(
    phase === 'review' && amount !== null && action
      ? async () => {
          const spending = isLido ? (mode === 'out' ? { token: LIDO_STETH, spender: LIDO_QUEUE } : null) : mode === 'in' ? { token: reserve!.asset, spender: pool } : null;
          if (spending && (await eth.allowance(spending.token, spending.spender)) < amount) {
            const ap = buildApproval({ ...spending, amount });
            return { report: await eth.simulateBeforeSigning(ap, pinned), approval: true };
          }
          const b = await call('earn_evm_build', { action: mode === 'claim' && claims[0] ? { kind: 'lidoClaim', requestId: claims[0].id.toString() } : action, ...(eth.account ? { account: eth.account } : {}) });
          return { report: await eth.simulateBeforeSigning({ to: b.to, data: b.data as Hex, value: BigInt(b.valueWei) }, pinned), approval: false };
        }
      : null,
    [phase, amount, mode, opt.id],
  );

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
          {!isLido && mode === 'in' && amount !== null && amount > 0n && !over && earnFee !== null && <MissingFee chainKey={asset.chainKey} need={earnFee} returnTo={{ name: 'staking' }} />}
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
          <SimulationPanel report={review.data?.report} loading={review.loading} {...(review.data?.approval ? { note: t('sim.nextCall') } : {})} />
          {mode === 'in' && (
            <Notice tone="info" icon={<IconShield size={15} className="mt-0.5 shrink-0 text-ice" />}>
              <div className="flex flex-col gap-2">
                <span className="flex items-center gap-2">
                  <Badge tone={RISK_TONE[earnRisk(opt)]}>{t(RISK_LABEL[earnRisk(opt)])}</Badge> {t(RISK_BODY[earnRisk(opt)])}
                </span>
                <RiskList opt={opt} />
              </div>
            </Notice>
          )}
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
