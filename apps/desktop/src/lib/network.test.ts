import { describe, expect, it } from 'vitest';
import { NETWORK_HINT, NETWORK_LABEL, networkSwitchText } from './network';

describe('network choice texts (§2.10)', () => {
  it('labels say what each network holds', () => {
    expect(NETWORK_LABEL.mainnet).toBe('Réseau principal');
    expect(NETWORK_HINT.mainnet).toBe('fonds réels');
    expect(NETWORK_LABEL.testnet).toBe('Réseau de test');
    expect(NETWORK_HINT.testnet).toBe('jetons sans valeur');
  });

  it('the confirmation says the other vault is kept, and what happens next', () => {
    const t = networkSwitchText({ network: 'testnet', otherVaultExists: false }, 'mainnet').join(' ');
    expect(t).toContain('Ton coffre du réseau de test est gardé');
    expect(t).toContain('rien n’est supprimé');
    expect(t).toContain('Aucun coffre sur le réseau principal');
    expect(t).toContain('vrais fonds');
    expect(t).toContain('redémarre');
    const back = networkSwitchText({ network: 'mainnet', otherVaultExists: true }, 'testnet').join(' ');
    expect(back).toContain('Un coffre existe déjà sur le réseau de test');
    expect(back).toContain('aucune valeur');
    expect(networkSwitchText({ network: 'mainnet', otherVaultExists: false }, 'testnet', false)[0]).toBe('Chaque réseau a son propre coffre : changer de réseau ne supprime rien.');
  });
});
