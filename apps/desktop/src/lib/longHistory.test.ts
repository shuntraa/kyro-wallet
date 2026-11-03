import { describe, expect, it } from 'vitest';
import { coinPeriods } from '../state/charts';
import { hasLongHistory } from './longHistory';

describe('All period', () => {
  it('is offered only for coins with a long history source', () => {
    expect(hasLongHistory('bitcoin')).toBe(true);
    expect(coinPeriods('bitcoin')).toContain('Tout');
    expect(hasLongHistory('kaspa')).toBe(false);
    expect(coinPeriods('kaspa')).not.toContain('Tout');
    expect(coinPeriods('kaspa')).toContain('1A');
  });
});
