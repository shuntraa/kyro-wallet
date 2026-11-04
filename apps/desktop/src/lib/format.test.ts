import { describe, expect, it } from 'vitest';
import { fmtChartTime } from './format';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4, 12);

describe('chart tooltip label', () => {
  const point = Date.UTC(2014, 10, 11, 12);

  it('names the year when the range covers a year or more, without the hour', () => {
    const label = fmtChartTime(point, NOW, 12 * 365 * DAY);
    expect(label).toContain('2014');
    expect(label).toMatch(/11/);
    expect(label).not.toMatch(/:/);
  });

  it('keeps the hour and no year on a short range', () => {
    const label = fmtChartTime(NOW - 40 * DAY, NOW, 30 * DAY);
    expect(label).not.toContain('2026');
    expect(label).toMatch(/\d:\d\d/);
  });
});
