import { afterEach, describe, expect, it } from 'vitest';
import { en, enAreas } from './en';
import { fr, frAreas } from './fr';
import { getLanguage, interpolate, setLanguage, setLanguagePreference, setSystemLanguage, t, tKey, tp } from './index';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<(\/?\w+)>/g)].map((m) => m[1]).sort();

describe('catalogs', () => {
  it('fr and en have exactly the same keys', () => {
    const f = Object.keys(fr).sort();
    const e = Object.keys(en).sort();
    expect(e.filter((k) => !(k in fr))).toEqual([]);
    expect(f.filter((k) => !(k in en))).toEqual([]);
    expect(e).toEqual(f);
  });

  it('each area has the same keys in both languages, prefixed by the area, without collisions', () => {
    expect(Object.keys(enAreas).sort()).toEqual(Object.keys(frAreas).sort());
    let total = 0;
    for (const [area, frMod] of Object.entries(frAreas)) {
      const enMod = enAreas[area as keyof typeof enAreas] as Record<string, string>;
      expect(Object.keys(enMod).sort(), area).toEqual(Object.keys(frMod).sort());
      const prefixes = area === 'common' ? ['common.', 'time.', 'errors.'] : [`${area}.`];
      for (const k of Object.keys(frMod)) expect(prefixes.some((p) => k.startsWith(p)), `${k} in ${area}`).toBe(true);
      total += Object.keys(frMod).length;
    }
    // A key defined in two areas would silently override the other one.
    expect(Object.keys(fr).length).toBe(total);
  });

  it('every translation keeps the same {placeholders} and <tags>, and is not empty', () => {
    const bad: string[] = [];
    for (const [k, f] of Object.entries(fr) as Array<[keyof typeof fr, string]>) {
      const e = en[k];
      if (!e.trim() || !f.trim()) bad.push(`${k}: empty`);
      if (placeholders(f).join() !== placeholders(e).join()) bad.push(`${k}: {${placeholders(f).join()}} ≠ {${placeholders(e).join()}}`);
      if (tags(f).join() !== tags(e).join()) bad.push(`${k}: <${tags(f).join()}> ≠ <${tags(e).join()}>`);
    }
    expect(bad).toEqual([]);
  });

  it('plural keys come in _one / _other pairs', () => {
    const keys = new Set(Object.keys(fr));
    const orphans = [...keys].filter((k) => (k.endsWith('_one') && !keys.has(k.replace(/_one$/, '_other'))) || (k.endsWith('_other') && !keys.has(k.replace(/_other$/, '_one'))));
    expect(orphans).toEqual([]);
  });
});

describe('t / tp', () => {
  afterEach(() => setLanguage('fr'));

  it('looks up the current language and interpolates', () => {
    setLanguage('fr');
    expect(t('common.cancel')).toBe('Annuler');
    expect(t('time.agoMinutes', { n: 3 })).toBe('il y a 3 min');
    setLanguage('en');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('time.agoMinutes', { n: 3 })).toBe('3 min ago');
    expect(tKey('errors.__nope__')).toBeNull();
    expect(interpolate('{a} et {b}', { a: 1 })).toBe('1 et {b}');
  });

  it('plural rules per language (French 0 and 1 are singular)', () => {
    setLanguage('fr');
    expect(tp('time.days', 0)).toBe('0 jour');
    expect(tp('time.days', 1)).toBe('1 jour');
    expect(tp('time.days', 2)).toBe('2 jours');
    setLanguage('en');
    expect(tp('time.days', 0)).toBe('0 days');
    expect(tp('time.days', 1)).toBe('1 day');
    expect(tp('time.days', 1200)).toBe('1,200 days');
  });

  it('auto follows the system language, an explicit choice wins', () => {
    setSystemLanguage('en');
    setLanguagePreference('auto');
    expect(getLanguage()).toBe('en');
    setSystemLanguage('fr');
    expect(getLanguage()).toBe('fr');
    setLanguagePreference('en');
    expect(getLanguage()).toBe('en');
    setSystemLanguage('en');
    setLanguagePreference('fr');
    expect(getLanguage()).toBe('fr');
  });
});
