import { describe, expect, it } from 'vitest';
import { assetsFor, allChains } from '@kyro/chains';
import { MARKS, iconTree, monogram, resolveMark, tickerColor, toSvgString, type MarkKey } from './marks';

describe('coin marks', () => {
  it('resolves by ticker, asset id, CoinGecko id, chain key and glyph', () => {
    expect(resolveMark({ symbol: 'BTC' })).toBe('btc');
    expect(resolveMark({ id: 'eth:42161', symbol: 'ETH' })).toBe('eth');
    expect(resolveMark({ id: 'cg:bitcoin' })).toBe('btc');
    expect(resolveMark({ id: 'avalanche-2' })).toBe('avax');
    expect(resolveMark({ id: 'polygon' })).toBe('pol');
    expect(resolveMark({ id: 'erc20:1:0xa0b8', symbol: 'USDC' })).toBe('usdc');
    expect(resolveMark({ id: 'trc20:TR7N', symbol: 'USDT' })).toBe('usdt');
    expect(resolveMark({ symbol: 'S' })).toBe('sonic');
    expect(resolveMark({ glyph: 'Ł' })).toBe('ltc');
    expect(resolveMark({ symbol: 'TON' })).toBe('gram');
    expect(resolveMark({ id: 'cg:the-open-network' })).toBe('gram');
    expect(resolveMark({ symbol: 'WETH' })).toBe('weth');
    expect(resolveMark({ symbol: 'NOPE' })).toBeUndefined();
  });

  it('draws every registry chain and every native asset', () => {
    for (const net of ['mainnet', 'testnet'] as const) {
      for (const c of allChains(net)) expect(resolveMark({ id: c.key }), c.key).toBeDefined();
      // Natives are all drawn; the long tail of tokens may fall back to the monogram.
      for (const a of assetsFor(net).filter((x) => x.kind === 'native')) expect(resolveMark({ id: a.id, symbol: a.symbol }), a.id).toBeDefined();
    }
  });

  it('covers the planned chains and tokens', () => {
    for (const t of ['bch', 'dash', 'xlm', 'near', 'sui', 'cro', 'mnt', 'flr', 'kaia', 'gno', 'hype', 'sei', 'cfx', 'link', 'uni', 'aave', 'shib', 'pepe', 'qnt', 'xmr', 'gram', 'atom', 'etc', 'weth', 'steth', 'arb', 'op', 'dot', 'apt', 'algo', 'kas', 'zec', 'hbar'])
      expect(resolveMark({ symbol: t }), t).toBe(t);
  });

  it('renders well-formed SVG with unique gradient ids', () => {
    for (const key of Object.keys(MARKS) as MarkKey[]) {
      const svg = toSvgString(iconTree({ mark: MARKS[key], color: MARKS[key].color }, `t${key}`));
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).not.toMatch(/NaN|undefined/);
      expect(svg).toContain(`id="t${key}b"`);
    }
  });

  it('monogram fallback: short, stable colour', () => {
    expect(monogram('LEO')).toBe('LEO');
    expect(monogram('PYUSD')).toBe('PY');
    expect(monogram('LEO', 20)).toBe('LE');
    expect(tickerColor('ABC')).toBe(tickerColor('abc'));
    expect(tickerColor('ABC')).toMatch(/^#[0-9a-f]{6}$/);
    expect(toSvgString(iconTree({ label: 'A&B', color: '#123456' }, 'x'))).toContain('A&amp;B');
  });
});
