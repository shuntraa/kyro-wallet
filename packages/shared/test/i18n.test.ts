import { afterEach, describe, expect, it } from 'vitest';
import { call, checkServerUrl, decimalMark, getLang, isCustomServerDown, isTorUnavailable, l10n, langFromLocales, resolveLang, setBackend, setLang } from '../src';
import { createMockBackend } from '../src/mock';
import { demoXlmText } from '../src/mock-stellar';

afterEach(() => setLang('fr'));

describe('display language for the packages', () => {
  it('French by default, l10n picks the current language', () => {
    expect(getLang()).toBe('fr');
    expect(l10n('Annuler', 'Cancel')).toBe('Annuler');
    setLang('en');
    expect(l10n('Annuler', 'Cancel')).toBe('Cancel');
  });

  it('demo amounts use the decimal mark of the language', () => {
    expect(decimalMark()).toBe(',');
    expect(demoXlmText(125_000_000n)).toBe('12,5 XLM');
    setLang('en');
    expect(decimalMark()).toBe('.');
    expect(demoXlmText(125_000_000n)).toBe('12.5 XLM');
    expect(demoXlmText(10_000_000n)).toBe('1 XLM');
  });

  it('maps locales and preferences', () => {
    expect(langFromLocales(['fr-CA', 'en-US'])).toBe('fr');
    expect(langFromLocales(['en-GB', 'fr-FR'])).toBe('en');
    expect(langFromLocales([])).toBe('en');
    expect(resolveLang('auto', 'fr')).toBe('fr');
    expect(resolveLang('en', 'fr')).toBe('en');
  });

  it('server checks speak the current language', () => {
    expect(checkServerUrl('https://x.onion', false)).toBe('adresse .onion : exige Tor activé');
    setLang('en');
    expect(checkServerUrl('https://x.onion', false)).toBe('.onion address: requires Tor enabled');
    expect(checkServerUrl('ftp://example.com', true)).toBe('scheme not allowed “ftp”');
  });

  it('error matchers accept the shell messages in both languages', () => {
    expect(isTorUnavailable('Tor indisponible : pas de circuit')).toBe(true);
    expect(isTorUnavailable('Tor unavailable: no circuit')).toBe(true);
    expect(isCustomServerDown(new Error('Server unreachable: node.example: connection timed out'))).toBe(true);
    expect(isCustomServerDown(new Error('Serveur injoignable : node.example'))).toBe(true);
  });

  it('demo backend errors follow the language', async () => {
    setBackend(createMockBackend({ network: 'testnet', confirm: () => true }).invoke);
    await call('vault_create', { password: 'correct horse', words: 24 });
    await call('vault_lock').catch(() => undefined);
    setLang('en');
    await expect(call('vault_unlock', { password: 'nope nope' })).rejects.toMatchObject({ code: 'WRONG_PASSWORD', message: 'Wrong password.' });
    setLang('fr');
    await expect(call('vault_unlock', { password: 'nope nope' })).rejects.toMatchObject({ code: 'WRONG_PASSWORD', message: 'Mot de passe incorrect.' });
  });
});
