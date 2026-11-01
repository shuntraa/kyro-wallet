// SPDX-License-Identifier: GPL-3.0-or-later
// Fiat currencies Kyro shows values in (all are CoinGecko `vs_currencies`).

export const FIAT_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'HKD', 'SGD', 'KRW', 'INR', 'BRL', 'MXN', 'ARS', 'TRY', 'PLN', 'CZK', 'SEK', 'NOK', 'DKK', 'ZAR', 'AED', 'ILS', 'RUB'] as const;
export type Currency = (typeof FIAT_CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = 'USD';

export function isCurrency(v: unknown): v is Currency {
  return typeof v === 'string' && (FIAT_CURRENCIES as readonly string[]).includes(v);
}

const EURO_REGIONS = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK', 'AD', 'MC', 'SM', 'VA', 'ME', 'XK', 'GF', 'GP', 'MQ', 'RE', 'YT', 'PM', 'BL', 'MF'];

/** Region (ISO 3166-1 alpha-2) → currency, for the regions whose currency Kyro offers. */
const REGION_CURRENCY: Record<string, Currency> = {
  ...Object.fromEntries(EURO_REGIONS.map((r) => [r, 'EUR' as Currency])),
  US: 'USD', PR: 'USD', EC: 'USD', SV: 'USD', PA: 'USD', GU: 'USD', VI: 'USD', AS: 'USD',
  GB: 'GBP', IM: 'GBP', JE: 'GBP', GG: 'GBP',
  CH: 'CHF', LI: 'CHF',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  JP: 'JPY',
  CN: 'CNY',
  HK: 'HKD',
  SG: 'SGD',
  KR: 'KRW',
  IN: 'INR',
  BR: 'BRL',
  MX: 'MXN',
  AR: 'ARS',
  TR: 'TRY',
  PL: 'PLN',
  CZ: 'CZK',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK', GL: 'DKK', FO: 'DKK',
  ZA: 'ZAR',
  AE: 'AED',
  IL: 'ILS',
  RU: 'RUB',
};

/** Language without a region (`fr`, `ja`…): a likely currency, only where it is unambiguous enough. */
const LANG_CURRENCY: Record<string, Currency> = {
  fr: 'EUR', de: 'EUR', it: 'EUR', nl: 'EUR', fi: 'EUR', el: 'EUR', et: 'EUR', lv: 'EUR', lt: 'EUR', sk: 'EUR', sl: 'EUR', ga: 'EUR', mt: 'EUR', hr: 'EUR',
  ja: 'JPY', ko: 'KRW', zh: 'CNY', pl: 'PLN', cs: 'CZK', sv: 'SEK', nb: 'NOK', nn: 'NOK', no: 'NOK', da: 'DKK', tr: 'TRY', he: 'ILS', ru: 'RUB', hi: 'INR',
};

/** Region of a locale tag: `fr-FR`, `fr_FR.UTF-8`, `zh-Hant-HK`, `en-GB@euro` → `FR`, `FR`, `HK`, `GB`. */
export function localeRegion(tag: string): string | null {
  const parts = tag.trim().split(/[.@]/)[0]?.split(/[-_]/) ?? [];
  for (const p of parts.slice(1)) if (/^[A-Za-z]{2}$/.test(p)) return p.toUpperCase();
  return null;
}

/** Currency for the computer's locales, in preference order: the first locale whose region (or, without a region, whose language) Kyro knows decides; */
export function currencyForLocales(locales: readonly string[] | undefined | null): Currency {
  for (const l of locales ?? []) {
    if (typeof l !== 'string' || l.trim() === '') continue;
    const r = localeRegion(l);
    if (r) {
      if (REGION_CURRENCY[r]) return REGION_CURRENCY[r];
      continue;
    }
    const lang = l.trim().split(/[-_.@]/)[0]?.toLowerCase() ?? '';
    if (LANG_CURRENCY[lang]) return LANG_CURRENCY[lang];
  }
  return DEFAULT_CURRENCY;
}

/** The WebView's currency (`navigator.languages`, then `Intl`): fallback before Rust answers, and in demo mode. */
export function navigatorCurrency(): Currency {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  const list = [...(nav?.languages ?? []), ...(nav?.language ? [nav.language] : [])];
  try {
    list.push(new Intl.NumberFormat().resolvedOptions().locale);
  } catch {
    /* no Intl: ignore */
  }
  return currencyForLocales(list);
}
