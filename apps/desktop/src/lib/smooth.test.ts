// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { chartPointBudget, downsample, fitSeries, pickPoints, smoothPath } from "./smooth";

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

// « All » joins ~5 years of weekly prices to one year of daily ones: placed by time, the last year
// takes a fifth of the width, not most of it; and the drawn points are real prices (no averages).
describe("chart by time", () => {
  const DAY = 86_400_000;
  const times: number[] = [];
  const values: number[] = [];
  for (let t = 0; t < 4 * 365 * DAY; t += 7 * DAY) times.push(t);
  for (let t = 4 * 365 * DAY; t <= 5 * 365 * DAY; t += DAY) times.push(t);
  times.forEach((_, i) => values.push(100 + Math.sin(i / 5) * 40 + (i === 150 ? 500 : 0)));

  it("places points by their time", () => {
    const kept = pickPoints(values, 240, times);
    const pts = fitSeries(kept.map((i) => values[i]!), { width: 1000, height: 100, xs: kept.map((i) => times[i]!) });
    const lastYear = kept.findIndex((i) => times[i]! >= 4 * 365 * DAY);
    expect(pts[lastYear]!.x).toBeGreaterThan(790);
    expect(pts[lastYear]!.x).toBeLessThan(810);
  });

  it("keeps real prices, the first, the last and the highest", () => {
    const kept = pickPoints(values, 240, times);
    expect(kept.length).toBeLessThanOrEqual(240);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(values.length - 1);
    expect(kept).toContain(150);
    for (let i = 1; i < kept.length; i++) expect(kept[i]!).toBeGreaterThan(kept[i - 1]!);
  });

  it("never draws a curve going back in time", () => {
    const d = smoothPath([{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 101, y: 50 }, { x: 102, y: 0 }]);
    // Each segment's control points stay between its two ends: then x never decreases.
    let start = 0;
    for (const m of d.matchAll(/C([\d.-]+),[\d.-]+ ([\d.-]+),[\d.-]+ ([\d.-]+),/g)) {
      const [c1, c2, end] = [Number(m[1]), Number(m[2]), Number(m[3])];
      for (const c of [c1, c2]) {
        expect(c).toBeGreaterThanOrEqual(start);
        expect(c).toBeLessThanOrEqual(end);
      }
      start = end;
    }
  });
});
