// SPDX-License-Identifier: GPL-3.0-or-later
// Smooth chart curves: Catmull-Rom spline converted to cubic Bézier segments.

export interface Pt {
  x: number;
  y: number;
}

const r = (n: number) => Math.round(n * 100) / 100;

/** Catmull-Rom (uniform, tension 0.5) → "M … C …" path. */
export function smoothPath(points: Pt[], opts: { clamp?: boolean } = {}): string {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length === 0) return '';
  const first = pts[0] as Pt;
  if (pts.length === 1) return `M${r(first.x)},${r(first.y)}`;
  const clamp = opts.clamp ?? true;
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const cy = (y: number) => (clamp ? Math.min(maxY, Math.max(minY, y)) : y);
  let d = `M${r(first.x)},${r(first.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i] as Pt;
    const p1 = pts[i] as Pt;
    const p2 = pts[i + 1] as Pt;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = cy(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = cy(p2.y - (p3.y - p1.y) / 6);
    d += ` C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(p2.x)},${r(p2.y)}`;
  }
  return d;
}

/** Close a line path into an area down to `bottom`. */
export function areaPath(line: string, points: Pt[], bottom: number): string {
  if (!line || points.length === 0) return '';
  const first = points[0] as Pt;
  const last = points[points.length - 1] as Pt;
  return `${line} L${r(last.x)},${r(bottom)} L${r(first.x)},${r(bottom)} Z`;
}

export interface FitOptions {
  width: number;
  height: number;
  padTop?: number;
  padBottom?: number;
}

/** Map values onto a width × height box (y grows downwards). Flat series sit in the middle. */
export function fitSeries(values: number[], o: FitOptions): Pt[] {
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length === 0) return [];
  const top = o.padTop ?? 0;
  const bottom = o.padBottom ?? 0;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;
  const h = o.height - top - bottom;
  const n = vals.length;
  return vals.map((v, i) => ({
    x: n === 1 ? o.width / 2 : (i / (n - 1)) * o.width,
    y: span === 0 ? top + h / 2 : top + (1 - (v - min) / span) * h,
  }));
}

/** Reduce a long series to at most `max` points (keeps first, last and local extremes per bucket). */
export function downsample(values: number[], max: number): number[] {
  if (values.length <= max || max < 3) return values;
  const out: number[] = [values[0] as number];
  const bucket = (values.length - 2) / (max - 2);
  for (let b = 0; b < max - 2; b++) {
    const start = 1 + Math.floor(b * bucket);
    const end = Math.min(values.length - 1, 1 + Math.floor((b + 1) * bucket));
    let sum = 0;
    for (let i = start; i < end; i++) sum += values[i] as number;
    out.push(end > start ? sum / (end - start) : (values[start] as number));
  }
  out.push(values[values.length - 1] as number);
  return out;
}

/** How many points a chart `width` px wide draws: about one every 2 px, between 16 and 240. */
export function chartPointBudget(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 240;
  return Math.max(16, Math.min(240, Math.round(width / 2)));
}
