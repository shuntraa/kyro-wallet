import { describe, expect, it } from 'vitest';
import { call, IpcError, setBackend } from '../src';
import { createMockBackend } from '../src/mock';

const PW = 'correct horse';
function setup(confirm: (s: string) => boolean = () => true) {
  const texts: string[] = [];
  const mock = createMockBackend({
    network: 'testnet',
    tor: 'ready',
    torEnabled: false,
    confirm: (s) => {
      texts.push(s);
      return confirm(s);
    },
    preset: { password: PW, unlocked: true },
  });
  setBackend(mock.invoke);
  return { mock, texts };
}
async function code(p: Promise<unknown>): Promise<IpcError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IpcError);
    return e as IpcError;
  }
  throw new Error('expected rejection');
}

describe('demo staking — Solana', () => {
  it('overview: 1 SOL devnet minimum, rent reserve, an active account with rewards', async () => {
    setup();
    const o = await call('sol_stake_overview');
    expect(o.minimumDelegation).toBe('1000000000');
    expect(o.rentExemptReserve).toBe('2282880');
    expect(o.accounts).toHaveLength(1);
    expect(o.accounts[0]).toMatchObject({ state: 'active', ours: true, canClose: false });
    expect(BigInt(o.accounts[0]!.withdrawable)).toBeGreaterThan(0n);
  });

  it('refusals: under the minimum, balance too low, unknown vote account, deactivating a non-delegated account', async () => {
    setup();
    const { validators } = await call('sol_stake_validators', {});
    const v = validators[0]!.voteAccount;
    expect((await code(call('sol_stake_build', { action: { kind: 'createAndDelegate', lamports: '999999999', voteAccount: v } }))).message).toMatch(/minimum de délégation/i);
    expect((await code(call('sol_stake_build', { action: { kind: 'createAndDelegate', lamports: '3200000000', voteAccount: v } }))).message).toMatch(/solde insuffisant/i);
    expect((await code(call('sol_stake_build', { action: { kind: 'createAndDelegate', lamports: '1000000000', voteAccount: 'x' } }))).message).toMatch(/compte de vote inconnu/i);
    const o = await call('sol_stake_overview');
    expect((await code(call('sol_stake_build', { action: { kind: 'delegate', stakeAccount: o.accounts[0]!.address, voteAccount: v } }))).message).toMatch(/pas inactif/i);
  });

  it('reinforced: delinquent or commission > 10 %; the 2nd dialog can refuse', async () => {
    setup((s) => !s.startsWith('Attention'));
    const { validators } = await call('sol_stake_validators', {});
    const bad = validators.find((x) => x.delinquent)!;
    const greedy = validators.find((x) => x.commission > 10)!;
    const ok = validators.find((x) => !x.delinquent && x.commission <= 10)!;
    const b1 = await call('sol_stake_build', { action: { kind: 'createAndDelegate', lamports: '1000000000', voteAccount: bad.voteAccount } });
    expect(b1.stake.warnings).toEqual([{ kind: 'delinquent' }]);
    expect(b1.stake.requiresExtraConfirmation).toBe(true);
    const b2 = await call('sol_stake_build', { action: { kind: 'createAndDelegate', lamports: '1000000000', voteAccount: greedy.voteAccount } });
    expect(b2.stake.warnings).toEqual([{ kind: 'highCommission', commission: greedy.commission }]);
    expect((await code(call('sol_stake_sign', { message: b2.message, password: PW }))).code).toBe('USER_REJECTED');
    const b3 = await call('sol_stake_build', { action: { kind: 'createAndDelegate', lamports: '1000000000', voteAccount: ok.voteAccount } });
    expect(b3.stake.requiresExtraConfirmation).toBe(false);
    expect(b3.summary.instructions.map((i) => i.type)).toEqual(['systemCreateAccountWithSeed', 'stakeInitialize', 'stakeDelegate']);
  });

  it('create → activating → active; deactivate in the same epoch closes at once', async () => {
    const { mock } = setup();
    const { validators } = await call('sol_stake_validators', {});
    const b = await call('sol_stake_build', { action: { kind: 'createAndDelegate', lamports: '1000000000', voteAccount: validators[2]!.voteAccount } });
    expect(b.stake.lamports).toBe((1_000_000_000n + 2_282_880n).toString());
    expect((await code(call('sol_stake_sign', { message: b.message, password: 'nope' }))).code).toBe('WRONG_PASSWORD');
    const s = await call('sol_stake_sign', { message: b.message, password: PW });
    const id = await call('sol_stake_broadcast', { message: b.message, signature: s.signature });
    expect(id.length).toBeGreaterThan(80);
    let o = await call('sol_stake_overview');
    const acc = o.accounts.find((a) => a.address === b.stake.stakeAccount)!;
    expect(acc.state).toBe('activating');
    // Deactivated in its own epoch: never active, withdrawable at once.
    const d = await call('sol_stake_build', { action: { kind: 'deactivate', stakeAccount: acc.address } });
    await call('sol_stake_broadcast', { message: d.message, signature: (await call('sol_stake_sign', { message: d.message, password: PW })).signature });
    o = await call('sol_stake_overview');
    expect(o.accounts.find((a) => a.address === acc.address)).toMatchObject({ state: 'inactive', canClose: true });
    const w = await call('sol_stake_build', { action: { kind: 'withdraw', stakeAccount: acc.address } });
    expect(w.stake.closesAccount).toBe(true);
    await call('sol_stake_broadcast', { message: w.message, signature: (await call('sol_stake_sign', { message: w.message, password: PW })).signature });
    expect((await call('sol_stake_overview')).accounts.some((a) => a.address === acc.address)).toBe(false);
    void mock;
  });

  it('active account: deactivating, then inactive after the epoch; withdrawing everything while active is refused', async () => {
    const { mock } = setup();
    const acc = (await call('sol_stake_overview')).accounts[0]!;
    expect((await code(call('sol_stake_build', { action: { kind: 'withdraw', stakeAccount: acc.address, lamports: acc.lamports } }))).message).toMatch(/au-delà du montant retirable/i);
    const d = await call('sol_stake_build', { action: { kind: 'deactivate', stakeAccount: acc.address } });
    await call('sol_stake_broadcast', { message: d.message, signature: (await call('sol_stake_sign', { message: d.message, password: PW })).signature });
    expect((await call('sol_stake_overview')).accounts[0]!.state).toBe('deactivating');
    mock.stake.advanceSolEpochs(1);
    expect((await call('sol_stake_overview')).accounts[0]).toMatchObject({ state: 'inactive', canClose: true });
  });
});

describe('demo staking — Cardano', () => {
  it('overview: registered, 2 ADA deposit, no vote delegation so no withdrawal', async () => {
    setup();
    const o = await call('ada_stake_overview');
    expect(o.keyDeposit).toBe('2000000');
    expect(o.stake.registered).toBe(true);
    expect(o.stake.delegatedDrep).toBeNull();
    expect(o.canWithdraw).toBe(false);
    expect((await code(call('ada_stake_build', { action: { kind: 'withdraw' } }))).message).toMatch(/délégation de vote/i);
  });

  it('reinforced: retiring, margin > 10 %, saturated pool, inactive DRep', async () => {
    const { mock } = setup();
    const pools = await call('ada_stake_pools', {});
    const by = (t: string) => pools.find((p) => p.ticker === t)!.poolId;
    expect((await call('ada_stake_build', { action: { kind: 'delegate', poolId: by('BYE') } })).context.warnings[0]?.kind).toBe('poolRetiring');
    expect((await call('ada_stake_build', { action: { kind: 'delegate', poolId: by('MRG') } })).context.warnings).toEqual([{ kind: 'highMargin', margin: 15 }]);
    expect((await call('ada_stake_build', { action: { kind: 'delegate', poolId: by('GROS') } })).context.warnings[0]?.kind).toBe('poolSaturated');
    const inactive = await call('ada_stake_build', { action: { kind: 'voteDelegate', drep: mock.stake.state.DREPS.inactive } });
    expect(inactive.context.warnings).toEqual([{ kind: 'drepInactive' }]);
    expect(inactive.context.requiresExtraConfirmation).toBe(true);
    const fine = await call('ada_stake_build', { action: { kind: 'delegate', poolId: by('KYRO'), drep: 'alwaysAbstain' } });
    expect(fine.context.requiresExtraConfirmation).toBe(false);
    expect(fine.summary.certificates.map((c) => c.type)).toEqual(['stakeDelegation', 'voteDelegation']);
    expect((await code(call('ada_stake_pool', { poolId: 'pool1nope' }))).code).toBe('INVALID_INPUT');
  });

  it('vote → withdraw → deregister refunds the deposit; delegating again pays it', async () => {
    setup();
    const sign = async (tx: string) => (await call('ada_stake_sign', { tx, password: PW })).tx;
    const v = await call('ada_stake_build', { action: { kind: 'voteDelegate', drep: 'alwaysAbstain' } });
    await call('ada_stake_broadcast', { tx: await sign(v.tx) });
    expect((await call('ada_stake_overview')).canWithdraw).toBe(true);
    const w = await call('ada_stake_build', { action: { kind: 'withdraw' } });
    expect(w.summary.withdrawn).toBe('12345678');
    expect(BigInt(w.context.netCost)).toBeLessThan(0n);
    await call('ada_stake_broadcast', { tx: await sign(w.tx) });
    const d = await call('ada_stake_build', { action: { kind: 'deregister' } });
    expect(d.summary.refund).toBe('2000000');
    expect((await code(call('ada_stake_broadcast', { tx: d.tx }))).message).toMatch(/non signée/i);
    await call('ada_stake_broadcast', { tx: await sign(d.tx) });
    expect((await call('ada_stake_overview')).stake.registered).toBe(false);
    const pools = await call('ada_stake_pools', { limit: 2 });
    expect(pools).toHaveLength(2);
    const again = await call('ada_stake_build', { action: { kind: 'delegate', poolId: pools[0]!.poolId, drep: 'alwaysAbstain' } });
    expect(again.summary.certificates[0]).toEqual({ type: 'stakeRegistration', deposit: '2000000' });
    expect(again.summary.deposit).toBe('2000000');
  });
});

describe('demo staking — TRON', () => {
  it('overview: 1-day unfreeze delay on Nile, votes and TRON Power', async () => {
    setup();
    const a = await call('tron_stake_overview');
    expect(a.unfreezeDelayDays).toBe(1);
    expect(a.tronPowerLimit).toBe(20);
    expect(a.tronPowerUsed).toBe(20);
    expect(a.nextClaimTime).toBe(0);
  });

  it('refusals: under 1 TRX, more than staked, votes over TRON Power, not an SR, 31 SR', async () => {
    setup();
    const ws = await call('tron_stake_witnesses');
    expect((await code(call('tron_stake_build', { action: { kind: 'freeze', resource: 'ENERGY', amount: '999999' } }))).message).toMatch(/minimum : 1 TRX/i);
    expect((await code(call('tron_stake_build', { action: { kind: 'unfreeze', resource: 'BANDWIDTH', amount: '1000000' } }))).message).toMatch(/dégel supérieur/i);
    expect((await code(call('tron_stake_build', { action: { kind: 'vote', votes: [{ address: ws[0]!.address, count: '21' }] } }))).message).toMatch(/TRON Power/i);
    expect((await code(call('tron_stake_build', { action: { kind: 'vote', votes: [{ address: 'TNotAWitness', count: '1' }] } }))).message).toMatch(/candidat SR/i);
    expect((await code(call('tron_stake_build', { action: { kind: 'vote', votes: ws.map((w) => ({ address: w.address, count: '0' })) } }))).message).toMatch(/1 à 30 SR/i);
    expect((await code(call('tron_stake_build', { action: { kind: 'withdrawUnfrozen' } }))).message).toMatch(/rien à retirer/i);
    expect((await code(call('tron_stake_build', { action: { kind: 'cancelAllUnfreeze' } }))).message).toMatch(/aucun dégel/i);
  });

  it('reinforced: rank > 127, an SR keeping 100 %, an unfreeze that cuts votes', async () => {
    setup((s) => !s.startsWith('Attention'));
    const ws = await call('tron_stake_witnesses');
    const far = ws.find((w) => !w.isPaid)!;
    const r1 = await call('tron_stake_build', { action: { kind: 'vote', votes: [{ address: far.address, count: '5' }] } });
    expect(r1.context.warnings).toEqual([{ kind: 'srNotPaid', address: far.address, rank: far.rank }]);
    const r2 = await call('tron_stake_build', { action: { kind: 'vote', votes: [{ address: ws[2]!.address, count: '5' }] } });
    expect(r2.context.warnings).toEqual([{ kind: 'brokerageAll', address: ws[2]!.address }]);
    expect(r2.context.witnesses[0]?.brokerage).toBe(100);
    const r3 = await call('tron_stake_build', { action: { kind: 'unfreeze', resource: 'ENERGY', amount: '5000000' } });
    expect(r3.context.warnings).toEqual([{ kind: 'votesReduced' }]);
    expect((await code(call('tron_stake_sign', { raw: r3.raw, password: PW }))).code).toBe('USER_REJECTED');
    const ok = await call('tron_stake_build', { action: { kind: 'vote', votes: [{ address: ws[0]!.address, count: '10' }] } });
    expect(ok.context.requiresExtraConfirmation).toBe(false);
  });

  it('freeze, unfreeze (1 day), withdraw; claim once per 24 h; broadcast via tron_broadcast', async () => {
    const { mock } = setup();
    const run = async (action: Parameters<typeof call<'tron_stake_build'>>[1]['action']) => {
      const b = await call('tron_stake_build', { action });
      const s = await call('tron_stake_sign', { raw: b.raw, password: PW });
      expect(s.signature).toMatch(/^[0-9a-f]{130}$/i);
      return call('tron_broadcast', { raw: b.raw, signature: s.signature });
    };
    await run({ kind: 'freeze', resource: 'BANDWIDTH', amount: '5000000' });
    let a = await call('tron_stake_overview');
    expect(a.stakedBandwidth).toBe('5000000');
    expect(a.balance).toBe('30000000');
    await run({ kind: 'claimRewards' });
    expect((await code(call('tron_stake_build', { action: { kind: 'claimRewards' } }))).message).toMatch(/récompense nulle|24 h/i);
    await run({ kind: 'unfreeze', resource: 'BANDWIDTH', amount: '5000000' });
    a = await call('tron_stake_overview');
    expect(a.unfreezing).toHaveLength(1);
    expect(a.withdrawableNow).toBe('0');
    mock.advance(86_400_000 + 1000);
    await call('vault_unlock', { password: PW });
    expect((await call('tron_stake_overview')).withdrawableNow).toBe('5000000');
    await run({ kind: 'withdrawUnfrozen' });
    a = await call('tron_stake_overview');
    expect(a.unfreezing).toHaveLength(0);
    expect(a.balance).toBe((30_000_000n + 1_250_000n + 5_000_000n).toString());
  });
});
