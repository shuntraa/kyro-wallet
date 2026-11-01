// SPDX-License-Identifier: GPL-3.0-or-later
//
// Locale-aware formatting (current interface language, see ../i18n): amounts, fiat, percentages,
// addresses in 4-char chunks, durations. FR « 1 234,56 € », EN « €1,234.56 ». Crypto amounts are
// bigint base units: never floats for values.

import { getLang, intlLocale, type Currency } from '@kyro/shared';
import { t } from '../i18n';

/** U+202F narrow no-break space (fr-FR group separator) and U+2212 minus sign. */
export const NNBSP = ' ';
export const MINUS = '−';

/** Decimal mark of the current language (`,` in French, `.` in English). */
export function decimalSep(): string {
  return getLang() === 'fr' ? ',' : '.';
}

/** Thousands separator of the current language (narrow NBSP in French, `,` in English). */
function groupSep(): string {
  return getLang() === 'fr' ? NNBSP : ',';
}

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const loc = intlLocale();
  const key = loc + JSON.stringify(opts);
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(loc, opts);
    nfCache.set(key, f);
  }
  return f;
}

const dfCache = new Map<string, Intl.DateTimeFormat>();
function df(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const loc = intlLocale();
  const key = loc + JSON.stringify(opts);
  let f = dfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(loc, opts);
    dfCache.set(key, f);
  }
  return f;
}

/** Normalise Intl output: (French) regular spaces → narrow NBSP; hyphen-minus → U+2212. */
function clean(s: string): string {
  const spaced = getLang() === 'fr' ? s.replace(/[  ]/g, NNBSP) : s;
  return spaced.replace(/^-/, MINUS).replace(/(\s)-/, `$1${MINUS}`);
}

export function fmtNumber(n: number, maxFrac = 2, minFrac = 0): string {
  return clean(nf({ minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac }).format(n));
}

/** A plain number in the current language with any Intl options ("1 234,5" / "1,234.5"). */
export function fmtIntl(n: number, opts: Intl.NumberFormatOptions = {}): string {
  return clean(nf(opts).format(n));
}

/** Minor units of a currency (EUR/USD 2, JPY/KRW 0), from Intl (ISO 4217). */
export function fiatDigits(currency: Currency): number {
  try {
    return nf({ style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Short symbol of a currency in the current language: "€", "$", "£", "¥", "CHF", "₩"… */
export function fiatSymbol(currency: Currency): string {
  try {
    return nf({ style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/**
 * "12 480,32 €", "1 234,50 $" (FR) — "€12,480.32", "$1,234.50", "¥12,480" (EN). Default decimals:
 * the currency's own (0 for JPY/KRW), two more for tiny values (a token at 0,004 €, at ¥0.37).
 * An explicit `decimals` is capped to the currency's (never "¥12,480.00").
 */
export function fmtFiat(value: number, currency: Currency, opts: { decimals?: number; sign?: boolean } = {}): string {
  const abs = Math.abs(value);
  const minor = fiatDigits(currency);
  const decimals = opts.decimals !== undefined ? Math.min(opts.decimals, minor) : abs > 0 && abs < 10 ** -minor ? minor + 2 : minor;
  const s = clean(nf({ style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value));
  return opts.sign && value > 0 ? `+${s}` : s;
}

/** Split a fiat amount for the big display (integer bright, decimals faint): {int:"12 480", rest:",32 €"} / {int:"€12,480", rest:".32"}. */
export function splitFiat(value: number, currency: Currency): { int: string; rest: string } {
  const minor = fiatDigits(currency);
  const s = fmtFiat(value, currency, { decimals: minor });
  if (minor === 0) return { int: s, rest: '' };
  const i = s.lastIndexOf(decimalSep());
  return i < 0 ? { int: s, rest: '' } : { int: s.slice(0, i), rest: s.slice(i) };
}

/** Group an integer string by 3 (narrow NBSP in French, comma in English). */
function groupInt(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep());
}

/**
 * Crypto amount from base units, truncated (never rounded up).
 * Default precision: ≥ 1000 → 2 dec., ≥ 1 → 4 dec., < 1 → all decimals up to 8 (BTC), else 6.
 */
export function fmtCrypto(amount: bigint, decimals: number, symbol?: string, maxFrac?: number): string {
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  const fracFull = decimals > 0 ? (v % base).toString().padStart(decimals, '0') : '';
  const digits = maxFrac ?? (int >= 1000n ? 2 : int >= 1n ? 4 : decimals <= 8 ? decimals : 6);
  let frac = fracFull.slice(0, digits).replace(/0+$/, '');
  if (int === 0n && frac === '' && v > 0n) {
    // Tiny amount: show the first significant digits instead of "0".
    const firstSig = fracFull.search(/[1-9]/);
    frac = fracFull.slice(0, Math.min(decimals, firstSig + 2)).replace(/0+$/, '');
  }
  const out = `${neg ? MINUS : ''}${groupInt(int.toString())}${frac ? decimalSep() + frac : ''}`;
  return symbol ? `${out}${NNBSP}${symbol}` : out;
}

/** "+1,82 %", "−0,64 %", "0,00 %" (FR) — "+1.82%", "−0.64%" (EN). */
export function fmtPct(p: number | null | undefined, opts: { sign?: boolean; decimals?: number } = {}): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  const d = opts.decimals ?? 2;
  const abs = nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(Math.abs(p));
  const zero = Number(Math.abs(p).toFixed(d)) === 0;
  const sign = zero ? '' : p < 0 ? MINUS : opts.sign === false ? '' : '+';
  return clean(`${sign}${abs}`) + (getLang() === 'fr' ? `${NNBSP}%` : '%');
}

/**
 * Split an address in 4-character blocks. EVM addresses keep "0x" glued to
 * the first block ("0x4F2a 9C83 …"), like on hardware wallet screens.
 */
export function chunkAddress(address: string, size = 4): string[] {
  const a = address.trim();
  const prefix = /^0x/i.test(a) ? a.slice(0, 2) : '';
  const body = a.slice(prefix.length);
  const out: string[] = [];
  for (let i = 0; i < body.length; i += size) out.push(body.slice(i, i + size));
  if (prefix && out.length) out[0] = prefix + out[0];
  return out;
}

export interface AddressChunk {
  text: string;
  /** First two and last two blocks: the ones to compare. */
  highlight: boolean;
}

export function addressChunks(address: string, size = 4): AddressChunk[] {
  const chunks = chunkAddress(address, size);
  const n = chunks.length;
  return chunks.map((text, i) => ({ text, highlight: i < 2 || i >= n - 2 }));
}

/** "0x9a3E…c41D" */
export function shortAddress(address: string, head?: number, tail = 4): string {
  const h = head ?? (address.startsWith('0x') ? 6 : 5);
  return address.length <= h + tail + 1 ? address : `${address.slice(0, h)}…${address.slice(-tail)}`;
}

/** Countdown "11:42" (or "1:02:03"). */
export function fmtCountdown(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

/** Confirmation delay: "< 1 min", "≈ 3 min", "≈ 1 h". */
export function fmtEta(secs: number): string {
  if (secs < 60) return '< 1 min';
  if (secs < 3600) return `≈ ${Math.round(secs / 60)} min`;
  return `≈ ${fmtNumber(secs / 3600, 1)} h`;
}

/** "il y a 42 s", "il y a 3 min" — "42 s ago", "3 min ago". */
export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return t('time.agoSeconds', { n: s });
  if (s < 3600) return t('time.agoMinutes', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.agoHours', { n: Math.floor(s / 3600) });
  return t('time.agoDays', { n: Math.floor(s / 86400) });
}

const timeFmt = { format: (d: Date) => df({ hour: '2-digit', minute: '2-digit' }).format(d) };
const dayFmt = { format: (d: Date) => df({ day: 'numeric', month: 'short' }).format(d) };
const dayLongFmt = { format: (d: Date) => df({ day: 'numeric', month: 'long' }).format(d) };
const monthFmt = { format: (d: Date) => df({ month: 'long', year: 'numeric' }).format(d) };

/** A date in the current language with any Intl options (default "27 oct. 2026" / "Oct 27, 2026"). */
export function fmtDate(ms: number, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  return df(opts).format(new Date(ms));
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Group label: "Aujourd'hui", "Hier", "27 octobre" — "Today", "Yesterday", "October 27". */
export function fmtDayGroup(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(d, today)) return t('time.today');
  if (sameDay(d, yesterday)) return t('time.yesterday');
  return dayLongFmt.format(d);
}

/** "Hier · 18:42", "27 oct. · 09:10", "14:08" (today) — "Yesterday · 6:42 PM". */
export function fmtWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return timeFmt.format(d);
  if (sameDay(d, new Date(now - 86_400_000))) return `${t('time.yesterday')} · ${timeFmt.format(d)}`;
  return `${dayFmt.format(d)} · ${timeFmt.format(d)}`;
}

export function fmtTime(ms: number): string {
  return timeFmt.format(new Date(ms));
}

export function fmtMonth(ms: number): string {
  const s = monthFmt.format(new Date(ms));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Chart tooltip label: "AUJ. 14:00", "27 OCT. 09:10" — "TODAY 02:00 PM", "OCT 27 09:10 AM". */
export function fmtChartTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return `${t('time.todayShort')} ${timeFmt.format(d)}`;
  return `${dayFmt.format(d)} ${timeFmt.format(d)}`.toUpperCase();
}

/**
 * Normalise a decimal typed by the user: digits and one decimal mark, returned with the current
 * language's mark (« 0,5 » / « 0.5 »). `,` and `.` are both accepted as the mark while typing.
 */
export function sanitizeDecimalInput(raw: string, maxDecimals: number): string {
  let s = raw.replace(/[^\d.,]/g, '');
  // A pasted « 1,234.56 » or « 1.234,56 »: both separators → the LAST one is the decimal mark,
  // the other one groups thousands (dropped). Before, « 1,234.56 » became 1,23456 (1 000 × less).
  // Only when the grouping is a clean thousands pattern and digits follow the decimal mark, so that
  // a stray key while typing (« 0,5. ») never turns 0,5 into 5. Otherwise, as before, the first
  // separator is the decimal mark and any later one is dropped.
  const cut = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  if (s.includes(',') && s.includes('.') && cut < s.length - 1) {
    const group = s[cut] === ',' ? '.' : ',';
    const intPart = s.slice(0, cut);
    if (new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(intPart)) s = `${intPart.split(group).join('')},${s.slice(cut + 1)}`;
  }
  s = s.replace(/\./g, ',');
  const i = s.indexOf(',');
  if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/,/g, '');
  const [int = '', frac] = s.split(',');
  const intClean = int.replace(/^0+(?=\d)/, '');
  return frac === undefined ? intClean : `${intClean || '0'}${decimalSep()}${frac.slice(0, maxDecimals)}`;
}

/** Base units → editable decimal string in the current language ("0,25" / "0.25"), no grouping. */
export function toInputDecimal(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const int = amount / base;
  const frac = decimals > 0 ? (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return frac ? `${int}${decimalSep()}${frac}` : int.toString();
}
