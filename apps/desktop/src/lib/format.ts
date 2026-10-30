// SPDX-License-Identifier: GPL-3.0-or-later
//
// fr-FR formatting: amounts, fiat, percentages, addresses in 4-char chunks,
// durations. Crypto amounts are bigint base units: never floats for values.

import type { Currency } from '@kyro/shared';

/** U+202F narrow no-break space (fr-FR group separator) and U+2212 minus sign. */
export const NNBSP = ' ';
export const MINUS = '−';

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(opts);
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('fr-FR', opts);
    nfCache.set(key, f);
  }
  return f;
}

/** Normalise Intl output: regular spaces → narrow NBSP, hyphen-minus → U+2212. */
function clean(s: string): string {
  return s.replace(/[  ]/g, NNBSP).replace(/^-/, MINUS).replace(/(\s)-/, `$1${MINUS}`);
}

export function fmtNumber(n: number, maxFrac = 2, minFrac = 0): string {
  return clean(nf({ minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac }).format(n));
}

/** "12 480,32 €", "1 234,50 $". */
export function fmtFiat(value: number, currency: Currency, opts: { decimals?: number; sign?: boolean } = {}): string {
  const abs = Math.abs(value);
  const decimals = opts.decimals ?? (abs > 0 && abs < 0.01 ? 4 : 2);
  const s = clean(nf({ style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value));
  return opts.sign && value > 0 ? `+${s}` : s;
}

/** Split a fiat amount for the big display (integer bright, decimals faint): {int:"12 480", rest:",32 €"}. */
export function splitFiat(value: number, currency: Currency): { int: string; rest: string } {
  const s = fmtFiat(value, currency, { decimals: 2 });
  const i = s.lastIndexOf(',');
  return i < 0 ? { int: s, rest: '' } : { int: s.slice(0, i), rest: s.slice(i) };
}

/** Group an integer string by 3 with narrow NBSP. */
function groupInt(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
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
  const out = `${neg ? MINUS : ''}${groupInt(int.toString())}${frac ? ',' + frac : ''}`;
  return symbol ? `${out}${NNBSP}${symbol}` : out;
}

/** "+1,82 %", "−0,64 %", "0,00 %". */
export function fmtPct(p: number | null | undefined, opts: { sign?: boolean; decimals?: number } = {}): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  const d = opts.decimals ?? 2;
  const abs = nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(Math.abs(p));
  const zero = Number(Math.abs(p).toFixed(d)) === 0;
  const sign = zero ? '' : p < 0 ? MINUS : opts.sign === false ? '' : '+';
  return clean(`${sign}${abs}`) + `${NNBSP}%`;
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

/** "il y a 42 s", "il y a 3 min". */
export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const dayLongFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });
const monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Group label: "Aujourd'hui", "Hier", "27 octobre". */
export function fmtDayGroup(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(d, today)) return 'Aujourd’hui';
  if (sameDay(d, yesterday)) return 'Hier';
  return dayLongFmt.format(d);
}

/** "Hier · 18:42", "27 oct. · 09:10", "14:08" (today). */
export function fmtWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return timeFmt.format(d);
  if (sameDay(d, new Date(now - 86_400_000))) return `Hier · ${timeFmt.format(d)}`;
  return `${dayFmt.format(d)} · ${timeFmt.format(d)}`;
}

export function fmtTime(ms: number): string {
  return timeFmt.format(new Date(ms));
}

export function fmtMonth(ms: number): string {
  const s = monthFmt.format(new Date(ms));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Chart tooltip label: "AUJ. 14:00", "27 OCT. 09:10". */
export function fmtChartTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return `AUJ. ${timeFmt.format(d)}`;
  return `${dayFmt.format(d)} ${timeFmt.format(d)}`.toUpperCase();
}

/** Normalise a decimal typed by the user (keeps digits and one comma). */
export function sanitizeDecimalInput(raw: string, maxDecimals: number): string {
  let s = raw.replace(/[^\d.,]/g, '').replace('.', ',');
  const i = s.indexOf(',');
  if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/,/g, '');
  const [int = '', frac] = s.split(',');
  const intClean = int.replace(/^0+(?=\d)/, '');
  return frac === undefined ? intClean : `${intClean || '0'},${frac.slice(0, maxDecimals)}`;
}

/** Base units → editable French decimal string ("0,25"), no grouping. */
export function toInputDecimal(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const int = amount / base;
  const frac = decimals > 0 ? (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return frac ? `${int},${frac}` : int.toString();
}
