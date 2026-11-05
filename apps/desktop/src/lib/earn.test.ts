// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { HW_STAKE } from './staking';
import { LIDO_QUEUE, parseUintArray, parseWithdrawalStatus, withdrawalStatusCall, AAVE_MARKETS, AAVE_POOL, EARN_OPTIONS, LIDO_STETH, aaveApyPercent, addrArg, earnBlock, earnRisk, earnRiskKeys, earnRowName, filterOptions, keepRate, parseReserveData, rateIsOld, rateLabelKey, ratesDue } from './earn';

describe('earn', () => {
  it('Aave APY from the ray liquidity rate (compounded per second)', () => {
    expect(aaveApyPercent(0n)).toBe(0);
    // 5% APR → ≈ 5.127% APY.
    expect(aaveApyPercent(5n * 10n ** 25n)).toBeCloseTo(5.127, 2);
    // Live USDT rate read on 2026-11-03: 3.41% APR → ≈ 3.469% APY.
    expect(aaveApyPercent(0x1c34f26cb2bfac84e4b0a6n)).toBeCloseTo(3.469, 2);
  });

  it('parses getReserveData (rate word 2, aToken word 8)', () => {
    const words = Array.from({ length: 15 }, () => '0'.repeat(64));
    words[2] = (5n * 10n ** 25n).toString(16).padStart(64, '0');
    words[8] = addrArg(AAVE_MARKETS['usdt-aave']!.aToken);
    const r = parseReserveData(`0x${words.join('')}`);
    expect(r.liquidityRate).toBe(5n * 10n ** 25n);
    expect(r.aToken).toBe(AAVE_MARKETS['usdt-aave']!.aToken);
    expect(() => parseReserveData('0x00')).toThrow();
  });

  it('pinned addresses (lowercase) match the Rust table (earn_evm.rs)', () => {
    for (const a of [AAVE_POOL, LIDO_STETH, ...Object.values(AAVE_MARKETS).flatMap((r) => [r.pool, r.asset, r.aToken])]) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    expect(AAVE_POOL).toBe('0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2');
    expect(LIDO_STETH).toBe('0xae7ab96520de3a18e5e111b5eaab095312d7fe84');
    expect(AAVE_MARKETS['usdt-aave']!.aToken).toBe('0x23878914efe38d27c4d67ab83ed1b93a74d4086a');
    expect(AAVE_MARKETS['usdc-aave-pol']!.aToken).toBe('0xa4d94019934d8333ef880abffbf2fdd611c762bd');
    expect(AAVE_MARKETS['usdc-aave-base']!.pool).toBe('0xa238dd80c259a72e81d7e4664a9801593f98d1c5');
  });

  it('Lido withdrawal queue reads', () => {
    expect(LIDO_QUEUE).toBe('0x889edc2edab5f40e902b864ad4d7ade8e412f9b1');
    const word = (v: bigint) => v.toString(16).padStart(64, '0');
    expect(parseUintArray(`0x${word(32n)}${word(2n)}${word(7n)}${word(9n)}`)).toEqual([7n, 9n]);
    expect(parseUintArray('0x')).toEqual([]);
    expect(withdrawalStatusCall([7n])).toBe(`0xb8c4b85a${word(32n)}${word(1n)}${word(7n)}`);
    const one = 10n ** 18n;
    const st = `0x${word(32n)}${word(2n)}${word(one)}${word(1n)}${word(1n)}${word(5n)}${word(1n)}${word(0n)}${word(2n * one)}${word(2n)}${word(1n)}${word(6n)}${word(0n)}${word(0n)}`;
    expect(parseWithdrawalStatus(st, [7n, 9n])).toEqual([
      { id: 7n, amountOfStETH: one, isFinalized: true, isClaimed: false },
      { id: 9n, amountOfStETH: 2n * one, isFinalized: false, isClaimed: false },
    ]);
    expect(() => parseWithdrawalStatus(st, [7n])).toThrow();
  });

  it('filters', () => {
    expect(filterOptions(EARN_OPTIONS, 'all')).toHaveLength(EARN_OPTIONS.length);
    expect(filterOptions(EARN_OPTIONS, 'stable').map((o) => o.symbol)).toEqual(['USDT', 'USDC', 'DAI', 'USDT', 'USDC', 'USDC', 'USDT', 'USDC']);
    for (const o of EARN_OPTIONS) if (o.target.kind === 'aave') expect(AAVE_MARKETS[o.target.market]?.symbol).toBe(o.symbol);
    expect(filterOptions(EARN_OPTIONS, 'staking').every((o) => o.type !== 'lending')).toBe(true);
  });
});

describe('earn routing', () => {
  const by = (id: string) => EARN_OPTIONS.find((o) => o.id === id)!;
  const all = () => true;
  it('Lido and Aave start from a hardware wallet too; staking tabs only for its chains', () => {
    for (const id of ['eth-lido', 'usdt-aave', 'usdc-aave-arb', 'usdc-aave-pol']) {
      expect(earnBlock(by(id), { hw: true, hasAccount: all, hasEvm: true }), id).toBeNull();
      expect(earnBlock(by(id), { hw: false, hasAccount: all, hasEvm: true }), id).toBeNull();
      expect(earnBlock(by(id), { hw: true, hasAccount: all, hasEvm: false }), id).toBe('mainnetOnly');
    }
    for (const id of ['sol', 'ada', 'trx', 'near', 'sui', 'apt']) {
      expect(earnBlock(by(id), { hw: true, hasAccount: all, hasEvm: true }), id).toBe('hw');
      expect(earnBlock(by(id), { hw: false, hasAccount: all, hasEvm: true }), id).toBeNull();
      expect(earnBlock(by(id), { hw: false, hasAccount: () => false, hasEvm: true }), id).toBe('noAccount');
    }
    const hwStake = (c: string) => (HW_STAKE.ledger as readonly string[]).includes(c);
    expect(earnBlock(by('sol'), { hw: true, hwStake, hasAccount: all, hasEvm: true })).toBeNull();
    expect(earnBlock(by('sol'), { hw: true, hwStake, hasAccount: () => false, hasEvm: true })).toBe('noAccount');
    expect(earnBlock(by('ada'), { hw: true, hwStake, hasAccount: all, hasEvm: true })).toBeNull();
    expect(earnBlock(by('near'), { hw: true, hwStake, hasAccount: all, hasEvm: true })).toBeNull();
    const trezor = (c: string) => (HW_STAKE.trezor as readonly string[]).includes(c);
    expect(earnBlock(by('near'), { hw: true, hwStake: trezor, hasAccount: all, hasEvm: true })).toBe('hw');
    expect(earnBlock(by('trx'), { hw: true, hwStake, hasAccount: all, hasEvm: true })).toBe('hw');
  });
});

describe('risk levels', () => {
  const of = (id: string) => EARN_OPTIONS.find((o) => o.id === id)!;

  it('the network staking is low, a contract on Ethereum medium, on another network high', () => {
    for (const id of ['sol', 'ada', 'trx', 'near', 'sui', 'apt']) expect(earnRisk(of(id))).toBe('low');
    for (const id of ['eth-lido', 'usdt-aave', 'usdc-aave', 'dai-aave', 'weth-aave']) expect(earnRisk(of(id))).toBe('medium');
    for (const id of ['usdt-aave-arb', 'usdc-aave-arb', 'usdc-aave-base', 'usdt-aave-pol', 'usdc-aave-pol']) expect(earnRisk(of(id))).toBe('high');
  });

  it('every option says what can go wrong', () => {
    for (const o of EARN_OPTIONS) expect(earnRiskKeys(o).length).toBeGreaterThan(1);
    expect(earnRiskKeys(of('usdc-aave-base'))).toContain('earn.rfBase');
    expect(earnRiskKeys(of('usdc-aave'))).toEqual(expect.arrayContaining(['earn.rfContract', 'earn.rfLiquidity', 'earn.rfPeg', 'earn.rfIssuer']));
    expect(earnRiskKeys(of('dai-aave'))).toContain('earn.rfPeg');
    expect(earnRiskKeys(of('dai-aave'))).not.toContain('earn.rfIssuer');
    expect(earnRiskKeys(of('weth-aave'))).not.toContain('earn.rfPeg');
  });

  it('the low risk filter keeps only the network staking', () => {
    expect(filterOptions(EARN_OPTIONS, 'low').map((o) => o.id)).toEqual(['sol', 'ada', 'trx', 'near', 'sui', 'apt']);
  });

  it('says which rates are before commission, and which are not compounded', () => {
    expect(rateLabelKey(of('sol'))).toBe('earn.estGross');
    expect(rateLabelKey(of('trx'))).toBe('earn.estAprGross');
    expect(rateLabelKey(of('sui'))).toBe('earn.est');
    expect(rateLabelKey(of('eth-lido'))).toBe('earn.estApr');
    expect(rateLabelKey(of('usdc-aave'))).toBe('earn.est');
  });
});

describe('row names', () => {
  it('the network of an Aave market moves to its badge', () => {
    const of = (id: string) => EARN_OPTIONS.find((o) => o.id === id)!;
    expect(earnRowName(of('usdt-aave-arb'))).toEqual({ name: 'Tether · Aave', network: 'Arbitrum' });
    expect(earnRowName(of('usdc-aave-base'))).toEqual({ name: 'USD Coin · Aave', network: 'Base' });
    expect(earnRowName(of('usdc-aave'))).toEqual({ name: 'USD Coin · Aave', network: null });
    expect(earnRowName(of('sol'))).toEqual({ name: 'Solana', network: null });
  });
});

describe('last known rate', () => {
  it('a failed read keeps the last rate, a new one replaces it', () => {
    const s = keepRate({}, 'sol', 5.2, 1000);
    expect(s).toEqual({ sol: { value: 5.2, at: 1000 } });
    expect(keepRate(s, 'sol', null, 2000)).toBe(s);
    expect(keepRate(s, 'sol', Number.NaN, 2000)).toBe(s);
    expect(keepRate(s, 'sol', 5.3, 2000)).toEqual({ sol: { value: 5.3, at: 2000 } });
    expect(keepRate(s, 'ada', 2, 2000).sol).toEqual(s.sol);
  });

  it('reads only what is missing or too old, and never twice at once', () => {
    const store = { sol: { value: 5, at: 1000 }, ada: { value: 2, at: 0 } };
    expect(ratesDue(['sol', 'ada', 'trx', 'apt'], store, new Set(['apt']), 1500, 1000)).toEqual(['ada', 'trx']);
    expect(ratesDue(['sol'], store, new Set(), 2000, 1000)).toEqual(['sol']);
  });

  it('a rate over an hour old says so', () => {
    expect(rateIsOld({ value: 1, at: 0 }, 3_600_000)).toBe(false);
    expect(rateIsOld({ value: 1, at: 0 }, 3_600_001)).toBe(true);
  });
});
