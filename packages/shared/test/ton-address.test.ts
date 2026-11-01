// TON user-friendly addresses: the same rules as wallet-core `ton_parse_address`, checked against
import { describe, expect, it } from 'vitest';
import { crc16Xmodem, parseTonAddress, sameTonAccount, tonAddressProblem, tonFriendly } from '../src/ton-address';

const HASH = '8a8627861a5dd96c9db3ce0807b122da5ed473934ce7568a5b4b1c361cbb28ae';

describe('TON addresses', () => {
  it('CRC-16/XMODEM check value', () => {
    expect(crc16Xmodem(new TextEncoder().encode('123456789'))).toBe(0x31c3);
  });

  it('formats and parses the four forms of one account', () => {
    const forms: Array<[string, boolean, boolean]> = [
      ['EQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorkdl', true, false],
      ['UQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorhqg', false, false],
      ['kQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorvzv', true, true],
      ['0QCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorqEq', false, true],
    ];
    for (const [s, bounceable, testnet] of forms) {
      expect(parseTonAddress(s)).toEqual({ workchain: 0, hash: HASH, bounceable, testnet });
      expect(tonFriendly(0, HASH, bounceable, testnet)).toBe(s);
      expect(sameTonAccount(s, forms[0]![0])).toBe(true);
    }
  });

  it('accepts standard base64 and masterchain forms', () => {
    expect(tonAddressProblem('EQAN6Dr3vziti1Kp9D3aEFqJX4bBVfCaV57Z+9jwKTBXICv8')).toBeNull();
    expect(tonAddressProblem('EQCmGW+z+UL00FmnhWaMvJq/i86YY5GlJP3uJW19KC5Tzq4C')).toBeNull();
    expect(parseTonAddress('Ef8JfFPRpHBV_tZpCurvxMJW69nt2js3SuGEWojGnOpCVPRe')?.workchain).toBe(-1);
  });

  it('refuses what wallet-core refuses', () => {
    for (const s of [
      'random string',
      'EQIcIZpPoMnWXd8FbC1KaLtcyIgVUlwsbFK_3P6f5uf_YyzoE',
      'EQIcIZpPoMnWXd8FbC1KaLtcyIgVUlwsbFK_3P6f5uf_YyE',
      'EQIcIZpPoMnWXd8FbC1KaLtcyIgVUlwsbFK_3P6f5uf_Yyw=',
      'EQEMzVEZ8n9_5GFEdsNPfl6Tx64Jjld88gEvi4BDFly4CSyl',
      'Ef7g6Yz890MpIpitnjeaPC5kAXl7nL_A_pi04U_Qzgfs3-Cj',
      'MwCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorsn8',
      'swCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsornJ2',
      'EQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsormVH',
      'EQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorpcF',
      `0:${HASH}`,
      'EQCmGW+z+UL00FmnhWaMvJq/i86YY5GlJP3uJW19KC5Tzq4-',
    ]) {
      expect(tonAddressProblem(s), s).not.toBeNull();
      expect(parseTonAddress(s)).toBeNull();
    }
    expect(tonAddressProblem(`0:${HASH}`)).toMatch(/brute/);
    expect(tonAddressProblem('EQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorpcF')).toMatch(/somme de contrôle/);
    expect(sameTonAccount('EQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorkdl', 'garbage')).toBe(false);
  });
});
