// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AAVE_POOL, AAVE_RESERVES, EARN_OPTIONS, LIDO_STETH, aaveApyPercent, addrArg, filterOptions, parseReserveData } from './earn';

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
    words[8] = addrArg(AAVE_RESERVES.USDT.aToken);
    const r = parseReserveData(`0x${words.join('')}`);
    expect(r.liquidityRate).toBe(5n * 10n ** 25n);
    expect(r.aToken).toBe(AAVE_RESERVES.USDT.aToken);
    expect(() => parseReserveData('0x00')).toThrow();
  });

  it('pinned addresses (lowercase) match the Rust table (earn_evm.rs)', () => {
    for (const a of [AAVE_POOL, LIDO_STETH, ...Object.values(AAVE_RESERVES).flatMap((r) => [r.asset, r.aToken])]) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    expect(AAVE_POOL).toBe('0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2');
    expect(LIDO_STETH).toBe('0xae7ab96520de3a18e5e111b5eaab095312d7fe84');
    expect(AAVE_RESERVES.USDT.aToken).toBe('0x23878914efe38d27c4d67ab83ed1b93a74d4086a');
  });

  it('filters', () => {
    expect(filterOptions(EARN_OPTIONS, 'all')).toHaveLength(EARN_OPTIONS.length);
    expect(filterOptions(EARN_OPTIONS, 'stable').map((o) => o.symbol)).toEqual(['USDT', 'USDC', 'DAI']);
    expect(filterOptions(EARN_OPTIONS, 'staking').every((o) => o.type !== 'lending')).toBe(true);
  });
});
