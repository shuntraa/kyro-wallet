// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { chartPointBudget, downsample, fitSeries, smoothPath } from "./smooth";

// 1D chart (5-minute candles) drawn in a narrow window: the line must stay one continuous
// left-to-right path covering the whole width, with no points dropped or reordered.
describe("narrow price chart", () => {
  const day = Array.from(
    { length: 288 },
    (_, i) => 100 + Math.sin(i / 7) * 5 + (i % 13 === 0 ? 9 : 0),
  );

  for (const width of [220, 320, 480, 1200]) {
    it(`stays continuous at ${width}px`, () => {
      const data = downsample(day, chartPointBudget(width));
      expect(data.every(Number.isFinite)).toBe(true);
      const pts = fitSeries(data, {
        width,
        height: 200,
        padTop: 24,
        padBottom: 18,
      });
      expect(pts.length).toBe(data.length);
      expect(pts[0]?.x).toBe(0);
      expect(pts[pts.length - 1]?.x).toBe(width);
      for (let i = 1; i < pts.length; i++) {
        const gap = (pts[i]?.x ?? 0) - (pts[i - 1]?.x ?? 0);
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThanOrEqual(width / 16 + 1e-9);
      }
      const d = smoothPath(pts);
      expect(d.match(/M/g)?.length).toBe(1);
      expect(d.match(/C/g)?.length).toBe(pts.length - 1);
    });
  }

  it("keeps the first and last price", () => {
    const data = downsample(day, chartPointBudget(200));
    expect(data[0]).toBe(day[0]);
    expect(data[data.length - 1]).toBe(day[day.length - 1]);
  });
});
