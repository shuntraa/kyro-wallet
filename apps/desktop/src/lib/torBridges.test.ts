import { describe, expect, it } from 'vitest';
import { bridgeProblem, splitBridgeLines } from './torBridges';

const FP = '4352E58420E68F5E40BF7C74FADDCCD9D1349413';

describe('Tor bridge lines', () => {
  it('splits on lines and drops blanks', () => {
    expect(splitBridgeLines(`\n  192.0.2.1:443 ${FP}  \r\n\r\nBridge 192.0.2.2:9001 ${FP}\n`)).toEqual([`192.0.2.1:443 ${FP}`, `Bridge 192.0.2.2:9001 ${FP}`]);
  });

  it('accepts plain bridges', () => {
    expect(bridgeProblem([`192.0.2.1:443 ${FP}`, `bridge [2001:db8::1]:9001 ${FP}`])).toBeNull();
    expect(bridgeProblem([])).toBeNull();
  });

  it('says when a line needs a transport Kyro does not have', () => {
    expect(bridgeProblem([`192.0.2.1:443 ${FP}`, `obfs4 192.0.2.2:443 ${FP} cert=abc iat-mode=0`])).toEqual({ line: 2, kind: 'transport' });
    expect(bridgeProblem(['Bridge snowflake 192.0.2.3:80'])).toEqual({ line: 1, kind: 'transport' });
  });

  it('refuses a line without a fingerprint', () => {
    expect(bridgeProblem(['192.0.2.1:443'])).toEqual({ line: 1, kind: 'format' });
    expect(bridgeProblem(['192.0.2.1:443 abcd'])).toEqual({ line: 1, kind: 'format' });
  });
});
