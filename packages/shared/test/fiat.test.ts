import { describe, expect, it } from 'vitest';
import { call, currencyForLocales, FIAT_CURRENCIES, isCurrency, setBackend } from '../src';
import { createMockBackend } from '../src/mock';

describe('fiat currency from the locale region', () => {
  it('maps the region, then the language, else USD', () => {
    expect(currencyForLocales(['fr-FR'])).toBe('EUR');
    expect(currencyForLocales(['de-CH', 'de'])).toBe('CHF');
    expect(currencyForLocales(['en-GB'])).toBe('GBP');
    expect(currencyForLocales(['en-US'])).toBe('USD');
    expect(currencyForLocales(['fr_CA.UTF-8'])).toBe('CAD');
    expect(currencyForLocales(['zh-Hant-HK'])).toBe('HKD');
    expect(currencyForLocales(['ja'])).toBe('JPY');
    expect(currencyForLocales(['sw-KE', 'nl-BE'])).toBe('EUR');
    expect(currencyForLocales(['en'])).toBe('USD');
    expect(currencyForLocales([])).toBe('USD');
    expect(currencyForLocales(null)).toBe('USD');
  });

  it('offers 26 currencies, and the demo backend accepts them all', async () => {
    expect(FIAT_CURRENCIES.length).toBe(26);
    expect(isCurrency('JPY')).toBe(true);
    expect(isCurrency('jpy')).toBe(false);
    setBackend(createMockBackend({ network: 'testnet', confirm: () => true }).invoke);
    const s = await call('settings_get');
    for (const c of ['JPY', 'CHF', 'BRL'] as const) expect((await call('settings_set', { settings: { ...s, currency: c } })).currency).toBe(c);
    await expect(call('settings_set', { settings: { ...s, currency: 'XYZ' as never } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
