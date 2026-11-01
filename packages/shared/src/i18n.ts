// SPDX-License-Identifier: GPL-3.0-or-later
//
// Display language shared by the packages (chains, swap, market, demo mocks). The desktop UI owns
// the choice (Settings → Display, `settings.language`) and calls `setLang` whenever it changes;
// packages only read it, at the moment they build a user-facing message, through `l10n(fr, en)`.
// Nothing here is persisted: the default is French until the UI says otherwise.

/** Languages Kyro is translated into. */
export type Lang = 'fr' | 'en';
/** `settings.language`: `auto` follows the computer's language (French if French, else English). */
export type LanguagePref = 'auto' | Lang;

export const LANGS: readonly Lang[] = ['fr', 'en'];

let current: Lang = 'fr';

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

/** BCP 47 tag for `Intl` (`fr-FR` / `en-US`). */
export function intlLocale(lang: Lang = current): string {
  return lang === 'fr' ? 'fr-FR' : 'en-US';
}

/** The message in the current language. Call it when the message is built, never at module load. */
export function l10n(fr: string, en: string): string {
  return current === 'fr' ? fr : en;
}

/** French when the first preferred language is French, English otherwise (`fr`, `fr-CA`, `fr_BE`…). */
export function langFromLocales(locales: readonly string[] | undefined | null): Lang {
  const first = locales?.find((l) => typeof l === 'string' && l.trim() !== '');
  return first && /^fr(?:[-_]|$)/i.test(first.trim()) ? 'fr' : 'en';
}

/** `auto` → the system language; otherwise the explicit choice. */
export function resolveLang(pref: LanguagePref | undefined, system: Lang): Lang {
  return pref === 'fr' || pref === 'en' ? pref : system;
}

/** The WebView's language (`navigator.languages`): fallback before Rust answers, and in demo mode. */
export function navigatorLang(): Lang {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  return langFromLocales(nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : []);
}
