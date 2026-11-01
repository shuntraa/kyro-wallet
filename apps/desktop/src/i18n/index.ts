// SPDX-License-Identifier: GPL-3.0-or-later
//
// Interface language: two catalogs (fr.ts = the original French wording, en.ts = English) with
// typed keys, `{param}` interpolation and `_one` / `_other` plurals (Intl.PluralRules). No
// dependency. The language comes from `settings.language` (auto / fr / en, saved by Rust) and,
// for `auto`, from the computer's language (Rust's `config_get.systemLanguage`, the WebView's
// `navigator.languages` before that). Changing it re-renders every component that calls `useT()`
// (or `useLang()`); code outside React calls `t()` / `tp()` directly when it builds a message.
//
// The packages (chains, swap, demo mocks) read the same language through `@kyro/shared`
// (`l10n(fr, en)`): `applyLanguage` keeps both in sync.

import { useSyncExternalStore } from 'react';
import { getLang, intlLocale, resolveLang, setLang, type Lang, type LanguagePref } from '@kyro/shared';
import { fr } from './fr';
import { en } from './en';

export type { Lang, LanguagePref } from '@kyro/shared';

export type Catalog = typeof fr;
export type Key = keyof Catalog;

const CATALOGS: Record<Lang, Record<Key, string>> = { fr, en };

/** `{name}` placeholders of a catalog string, as a union of names. */
type Placeholders<S> = S extends `${string}{${infer P}}${infer R}` ? P | Placeholders<R> : never;
type ParamValue = string | number;
/** `t(key)` when the French string has no `{…}`, `t(key, { … })` with exactly its names otherwise. */
export type ParamsOf<K extends Key> = [Placeholders<Catalog[K]>] extends [never] ? [] : [params: Record<Placeholders<Catalog[K]>, ParamValue>];

/** Keys that exist as `<base>_one` + `<base>_other`: usable with `tp(base, count)`. */
export type PluralBase = { [K in Key]: K extends `${infer B}_one` ? (`${B}_other` extends Key ? B : never) : never }[Key];
type PluralParams<B extends PluralBase> = Exclude<Placeholders<Catalog[`${B}_one` & Key]> | Placeholders<Catalog[`${B}_other` & Key]>, 'count'>;
export type PluralParamsOf<B extends PluralBase> = [PluralParams<B>] extends [never] ? [] : [params: Record<PluralParams<B>, ParamValue>];

// ---------------------------------------------------------------- state

let pref: LanguagePref = 'auto';
let system: Lang = getLang();
const listeners = new Set<() => void>();

function applyLanguage(): void {
  const next = resolveLang(pref, system);
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (next === getLang()) return;
  setLang(next);
  pluralRules = null;
  for (const l of listeners) l();
}

/** The user's choice (`settings.language`). Applied immediately. */
export function setLanguagePreference(p: LanguagePref | undefined): void {
  pref = p === 'fr' || p === 'en' ? p : 'auto';
  applyLanguage();
}

/** The computer's language (what `auto` means). */
export function setSystemLanguage(l: Lang): void {
  system = l;
  applyLanguage();
}

/** Forces a language (tests). */
export function setLanguage(l: Lang): void {
  pref = l;
  applyLanguage();
}

export function getLanguage(): Lang {
  return getLang();
}

/** BCP 47 tag of the current language for `Intl` (`fr-FR` / `en-US`). */
export function locale(): string {
  return intlLocale(getLang());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---------------------------------------------------------------- lookup

function lookup(key: string): string {
  const lang = getLang();
  return (CATALOGS[lang] as Record<string, string>)[key] ?? (CATALOGS.fr as Record<string, string>)[key] ?? key;
}

/** Replaces `{name}` with `params.name` (unknown names are left as they are). */
export function interpolate(s: string, params?: Record<string, ParamValue>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** The string of `key` in the current language, `{…}` replaced by `params`. */
export function t<K extends Key>(key: K, ...args: ParamsOf<K>): string {
  return interpolate(lookup(key), args[0] as Record<string, ParamValue> | undefined);
}

let pluralRules: Intl.PluralRules | null = null;

/** `<base>_one` or `<base>_other` by the language's plural rules (FR: 0 and 1 are singular); `{count}` = the number, grouped. */
export function tp<B extends PluralBase>(base: B, count: number, ...args: PluralParamsOf<B>): string {
  pluralRules ??= new Intl.PluralRules(locale());
  const form = pluralRules.select(count) === 'one' ? 'one' : 'other';
  const params = { ...(args[0] as Record<string, ParamValue> | undefined), count: new Intl.NumberFormat(locale()).format(count) };
  return interpolate(lookup(`${base}_${form}`), params);
}

/** Untyped lookup for keys built at run time (`errors.${code}`): `null` when the key does not exist. */
export function tKey(key: string, params?: Record<string, ParamValue>): string | null {
  const s = (CATALOGS[getLang()] as Record<string, string>)[key];
  return s === undefined ? null : interpolate(s, params);
}

// ---------------------------------------------------------------- React

/** The current language; re-renders the component when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** `t` / `tp` bound to the current language; re-renders the component when it changes. */
export function useT(): { t: typeof t; tp: typeof tp; lang: Lang } {
  const lang = useLang();
  return { t, tp, lang };
}
