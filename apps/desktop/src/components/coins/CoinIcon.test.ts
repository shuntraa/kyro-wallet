import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { assetsFor } from '@kyro/chains';
import { CoinIcon, type CoinIconProps } from './CoinIcon';

const html = (p: CoinIconProps) => renderToStaticMarkup(createElement(CoinIcon, p));

describe('CoinIcon', () => {
  it('draws the mark for a known ticker (no monogram text, no remote image)', () => {
    const out = html({ symbol: 'BTC', size: 34 });
    expect(out).toContain('<svg');
    expect(out).not.toContain('<text');
    expect(out).not.toMatch(/<img|href="http/);
    expect(out).toContain('stop-color');
  });

  it('TON is drawn with the Gram mark', () => {
    expect(html({ symbol: 'TON' })).toBe(html({ symbol: 'GRAM' }));
    expect(html({ id: 'cg:the-open-network' })).toBe(html({ symbol: 'GRAM' }));
  });

  it('legacy glyph + colour props still render (monogram when unknown)', () => {
    const out = html({ glyph: 'Z', color: '#123456' });
    expect(out).toContain('>Z</text>');
    expect(out).toMatch(/stop-color="#[0-9a-f]{6}"/);
  });

  it('unknown token: ticker initials on a coloured disc', () => {
    expect(html({ symbol: 'LEO' })).toContain('>LEO</text>');
    expect(html({ symbol: 'PYUSD' })).toContain('>PY</text>');
  });

  it('chain badge on tokens and L2 ether, none on the native asset', () => {
    const mainnet = assetsFor('mainnet');
    const usdcArb = mainnet.find((a) => a.symbol === 'USDC' && a.chainKey === 'arbitrum');
    const eth = mainnet.find((a) => a.id === 'eth:1') ?? mainnet.find((a) => a.chainKey === 'ethereum' && a.kind === 'native');
    expect(usdcArb).toBeDefined();
    expect(eth).toBeDefined();
    const svgCount = (s: string) => s.split('<svg').length - 1;
    expect(svgCount(html({ asset: usdcArb! }))).toBe(2);
    expect(svgCount(html({ asset: eth! }))).toBe(1);
    expect(svgCount(html({ glyph: 'U', color: '#000000', badge: { glyph: 'T', color: '#EB0029' } }))).toBe(2);
  });

  it('every mainnet asset gets a drawn mark', () => {
    for (const a of assetsFor('mainnet')) expect(html({ asset: { ...a, chainKey: undefined } }), a.id).not.toContain('<text');
  });
});
