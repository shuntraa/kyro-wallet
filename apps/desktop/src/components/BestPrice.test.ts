import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '@kyro/shared';
import type { Quote } from '@kyro/swap';
import { BestPrice, routeLabel } from './BestPrice';

const quote = (over: Partial<Quote>): Quote => ({
  provider: 'near',
  providerName: 'NEAR Intents',
  buyAmount: 1_662_000_000_000_000_000n,
  minBuyAmount: 1_653_690_000_000_000_000n,
  gasFeeFiat: null,
  providerFeeFiat: 30.53,
  providerFeeIncluded: true,
  kyroFeeBps: 78,
  priceImpact: null,
  allowanceTarget: null,
  tx: { kind: 'deposit', chain: 'bitcoin', prepare: () => Promise.reject(new Error('unused')), reconfirm: () => Promise.reject(new Error('unused')) },
  etaSecs: 812,
  ...over,
});

const html = (quotes: Quote[]) =>
  renderToStaticMarkup(createElement(BestPrice, { quotes, sell: { symbol: 'BTC', decimals: 8 }, buy: { symbol: 'ETH', decimals: 18 }, sellChain: 'Bitcoin', buyChain: 'Ethereum', currency: 'USD' }))
    .replace(/<[^>]+>/g, '|')
    .replace(/[  ]/g, ' ');

describe('BestPrice', () => {
  afterEach(() => setLang('en'));

  it('shows what the selected quote costs, from the quote itself', () => {
    setLang('en');
    const text = html([quote({})]);
    for (const part of ['NEAR Intents', 'Best', '1.662 ETH', 'Route', 'BTC → ETH', 'Minimum received', '1.65369 ETH', 'Kyro fee', '0.78%', 'Provider fee', '≈ $30.53', 'Estimated time', '≈ 14 min']) expect(text).toContain(part);
    expect(text).not.toContain('Other quotes');
  });

  it('speaks French', () => {
    setLang('fr');
    const text = html([quote({})]);
    for (const part of ['Minimum reçu', 'Frais Kyro', '0,78 %', 'Frais du fournisseur', 'Temps estimé']) expect(text).toContain(part);
  });

  it('leaves out what the quote does not expose', () => {
    setLang('en');
    for (const providerFeeFiat of [null, 0]) {
      const q = quote({ providerFeeFiat });
      delete q.etaSecs;
      const text = html([q]);
      expect(text).not.toContain('Provider fee');
      expect(text).not.toContain('Estimated time');
      expect(text).toContain('Kyro fee');
    }
  });

  it('says when a provider fee comes on top of the quote', () => {
    setLang('en');
    expect(html([quote({ providerFeeIncluded: false })])).toContain('≈ $30.53 · on top');
  });

  it('keeps the order it is given: the first quote is the selected one', () => {
    setLang('en');
    const text = html([quote({}), quote({ provider: 'lifi', providerName: 'LI.FI', buyAmount: 1_650_000_000_000_000_000n })]);
    expect(text.indexOf('NEAR Intents')).toBeLessThan(text.indexOf('Other quotes'));
    expect(text.indexOf('Other quotes')).toBeLessThan(text.indexOf('LI.FI'));
    expect(text).toContain('1.65 ETH');
  });

  it('renders nothing without a quote', () => {
    expect(html([])).toBe('');
  });

  it('names the networks when the coin stays the same', () => {
    expect(routeLabel('BTC', 'ETH', 'Bitcoin', 'Ethereum')).toBe('BTC → ETH');
    expect(routeLabel('USDC', 'USDC', 'Base', 'Arbitrum')).toBe('USDC (Base) → USDC (Arbitrum)');
  });
});
