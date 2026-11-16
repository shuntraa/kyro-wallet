// SPDX-License-Identifier: GPL-3.0-or-later
// Charts: smooth Catmull-Rom curves (no angles), ice-blue line drawn from the left on mount, a
// faint ice wash under it, hover crosshair + tooltip.

import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { areaPath, chartPointBudget, downsample, fitSeries, pickPoints, smoothPath } from '../lib/smooth';
import { EASE_OUT } from './motion';
import { t } from '../i18n';

const VB_W = 1000;

export interface SmoothChartProps {
  values: number[];
  times?: number[];
  /** Height in px; with `fit`, the maximum: the chart then fills its flex parent and follows it. */
  height: number;
  fit?: boolean;
  /** When it changes, the curve fades in anew (a series extended to the left, not a new chart). */
  revealKey?: string;
  renderTooltip?: (i: number) => { label: string; value: string };
  defaultPoint?: 'last' | 'max' | 'none';
  defaultLabel?: string;
  padTop?: number;
  padBottom?: number;
  ariaLabel: string;
  className?: string;
  stroke?: string;
  /** Coin light: the line glows in its own colour (the tooltip stays sharp). */
  glow?: boolean;
}

export function SmoothChart({ values, times, height: maxH, fit = false, revealKey, renderTooltip, defaultPoint = 'last', defaultLabel, padTop = 24, padBottom = 18, ariaLabel, className, stroke = '#7CC4FF', glow = false }: SmoothChartProps) {
  const gid = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Draw in real pixels: a stretched viewBox squeezed the curve sideways in a narrow window and
  // parts of the stroke went missing. One point per ~2 px, re-measured on every resize.
  // Width and height both followed (`fit`): a smaller window recomputes the y scale too, so the
  // line always stays inside the plot area instead of being cut by the card.
  const [vbW, setVbW] = useState(VB_W);
  const [fitH, setFitH] = useState(maxH);
  const height = fit ? fitH : maxH;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const b = el.getBoundingClientRect();
      const w = Math.round(b.width);
      if (w > 0) setVbW(w);
      const h = Math.round(b.height);
      if (fit && h > 0) setFitH(Math.min(maxH, h));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, maxH]);
  // The top padding (room for the tooltip) shrinks with a short chart, never below a usable plot.
  const top = Math.min(padTop, Math.round(height * 0.3));
  const bottom = Math.min(padBottom, Math.round(height * 0.1));
  // Real points (never averages), placed by their time when `times` is given: « All » joins weekly
  // and daily prices, and by index the last year took most of the width.
  const kept = useMemo(() => pickPoints(values, chartPointBudget(vbW), times && times.length === values.length ? times : undefined), [values, times, vbW]);
  const data = useMemo(() => kept.map((i) => values[i] as number), [kept, values]);
  const xs = useMemo(() => (times && times.length === values.length ? kept.map((i) => times[i] as number) : kept), [kept, times, values.length]);
  // 2 px inset on each side: the stroke and the end point never get clipped at the edges.
  const pts = useMemo(() => fitSeries(data, { width: Math.max(1, vbW - 4), height, padTop: top, padBottom: bottom, xs }).map((q) => ({ x: q.x + 2, y: q.y })), [data, xs, vbW, height, top, bottom]);
  const line = useMemo(() => smoothPath(pts), [pts]);
  const area = useMemo(() => areaPath(line, pts, height), [line, pts, height]);

  const fallback = useMemo(() => {
    if (defaultPoint === 'none' || pts.length === 0) return null;
    if (defaultPoint === 'last') return pts.length - 1;
    let m = 0;
    data.forEach((v, i) => {
      if (v > (data[m] ?? -Infinity)) m = i;
    });
    return m;
  }, [defaultPoint, pts.length, data]);
  const idx = hover ?? fallback;
  const p = idx !== null ? pts[idx] : undefined;
  const tip = idx !== null && renderTooltip && kept[idx] !== undefined ? renderTooltip(kept[idx]) : null;

  const onMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || pts.length === 0) return;
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * vbW;
    // Nearest drawn point by x (the points are not evenly spaced).
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pts[mid] as { x: number }).x < x) lo = mid + 1;
      else hi = mid;
    }
    const prev = lo > 0 ? lo - 1 : lo;
    const best = Math.abs((pts[prev] as { x: number }).x - x) <= Math.abs((pts[lo] as { x: number }).x - x) ? prev : lo;
    setHover(best);
  };

  return (
    <div ref={ref} className={className} style={fit ? { position: 'relative', flex: '1 1 0', minHeight: 0, maxHeight: maxH } : { position: 'relative', height }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg width="100%" height={height} style={{ display: 'block' }} viewBox={`0 0 ${vbW} ${height}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel} className="chart-reveal">
        <defs>
          <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity="0.16" />
            <stop offset="0.6" stopColor={stroke} stopOpacity="0.04" />
            <stop offset="1" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`h${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity="0.34" />
            <stop offset="0.7" stopColor={stroke} stopOpacity="0.07" />
            <stop offset="1" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
          {/* Under the pointer the curve is lit up to that point: the past you are reading stands out. */}
          <clipPath id={`c${gid}`}>
            <rect x="0" y="0" width={hover !== null && p ? p.x : 0} height={height} style={{ transition: 'width 140ms ease-out' }} />
          </clipPath>
        </defs>
        <g key={revealKey} className={revealKey === undefined ? undefined : 'fade-in'}>
          {area && <path d={area} fill={`url(#g${gid})`} />}
          {area && <path d={area} fill={`url(#h${gid})`} clipPath={`url(#c${gid})`} style={{ opacity: hover !== null ? 1 : 0, transition: 'opacity 200ms ease-out' }} />}
          {line && <path d={line} fill="none" stroke={stroke} strokeWidth={hover !== null ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'stroke-width 200ms ease-out', ...(glow || hover !== null ? { filter: `drop-shadow(0 0 ${hover !== null ? 8 : 6}px ${stroke}99)` } : {}) }} />}
        </g>
      </svg>
      {p && (
        <>
          {/* The pointer line fades out toward the bottom, in the curve's colour. */}
          <div aria-hidden="true" style={{ position: 'absolute', left: `${(p.x / vbW) * 100}%`, top: 0, bottom: 0, width: 1, background: `linear-gradient(180deg, transparent, ${stroke}66 18%, ${stroke}1f 85%, transparent)`, opacity: hover !== null ? 1 : 0.55, transition: 'left 140ms ease-out, opacity 200ms ease-out' }} />
          <div
            aria-hidden="true"
            className="fade-in"
            style={{ position: 'absolute', left: `${(p.x / vbW) * 100}%`, top: p.y, width: 11, height: 11, margin: '-5.5px 0 0 -5.5px', borderRadius: 999, background: stroke, border: '2.5px solid #0b0e13', boxShadow: `0 0 0 ${hover !== null ? 5 : 3}px ${stroke}2e, 0 0 16px ${stroke}`, transition: 'left 140ms ease-out, top 140ms ease-out, box-shadow 200ms ease-out' }}
          />
          {tip && (
            <div
              style={{
                position: 'absolute',
                left: `clamp(110px, ${(p.x / vbW) * 100}%, calc(100% - 110px))`,
                top: Math.max(0, p.y - 84),
                transform: 'translateX(-50%)',
                transition: 'left 140ms ease-out, top 140ms ease-out',
                boxShadow: `0 14px 34px -14px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.07), 0 0 0 1px ${stroke}2e`,
              }}
              className="pointer-events-none flex flex-col items-start gap-1 rounded-[12px] bg-[#12161c]/92 px-3.5 py-2.5 whitespace-nowrap backdrop-blur-md"
            >
              <span className="flex items-center gap-1.5 text-[12px] leading-none text-mute">
                <span aria-hidden="true" className="size-[5px]" style={{ background: stroke, boxShadow: `0 0 8px ${stroke}` }} />
                {tip.label}
                {hover === null && defaultLabel && <span className="rounded-full bg-ice/[.12] px-1.5 py-[3px] text-[11px] leading-none font-medium text-ice">{defaultLabel}</span>}
              </span>
              <span className="figure text-[17px] leading-tight font-semibold text-text">{tip.value}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Small trend line. `glow` lights it in its colour; `fill` adds a faint wash under it. */
export function Sparkline({ values, color, width = 96, height = 28, glow = false, fill = false }: { values: number[]; color: string; width?: number; height?: number; glow?: boolean; fill?: boolean }) {
  const gid = useId().replace(/:/g, '');
  const pts = useMemo(() => fitSeries(downsample(values, 32), { width: width - 4, height, padTop: 4, padBottom: 4 }).map((p) => ({ x: p.x + 2, y: p.y })), [values, width, height]);
  const d = useMemo(() => smoothPath(pts), [pts]);
  const area = useMemo(() => (fill && d ? areaPath(d, pts, height) : ''), [fill, d, pts, height]);
  if (!d) return <span style={{ width, height }} className="inline-block" />;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ overflow: 'visible' }}>
      {area && (
        <>
          <defs>
            <linearGradient id={`s${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.22" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#s${gid})`} />
        </>
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" style={glow ? { filter: `drop-shadow(0 0 4px ${color}aa)` } : undefined} />
    </svg>
  );
}

export interface RingSlice {
  id: string;
  label: string;
  value: number;
  color: string;
}

/** Allocation as one ruled bar: slices grow from the left on mount, 2 px gaps between them. */
export function AllocationBar({ slices, className }: { slices: RingSlice[]; className?: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const label = slices.map((s) => `${s.label} ${total ? Math.round((s.value / total) * 100) : 0} %`).join(', ');
  return (
    <div role="img" aria-label={label || t('shell.noAllocation')} className={`flex h-2 w-full gap-[2px] overflow-hidden rounded-[2px] bg-control ${className ?? ''}`}>
      {total > 0 &&
        slices.map((s, i) => (
          <motion.span
            key={s.id}
            className="h-full basis-0 first:rounded-l-[2px] last:rounded-r-[2px]"
            style={{ background: s.color }}
            initial={{ flexGrow: 0 }}
            animate={{ flexGrow: s.value / total }}
            transition={{ duration: 0.5, delay: 0.06 * i, ease: EASE_OUT }}
          />
        ))}
    </div>
  );
}

/** Allocation ring (r = 48, stroke 10) with gaps between slices. */
export function AllocationRing({ slices, center, size = 120 }: { slices: RingSlice[]; center: ReactNode; size?: number }) {
  const r = 48;
  const c = 2 * Math.PI * r;
  const total = slices.reduce((s, x) => s + x.value, 0);
  const gap = slices.length > 1 ? 3 : 0;
  let offset = 0;
  const label = slices.map((s) => `${s.label} ${total ? Math.round((s.value / total) * 100) : 0} %`).join(', ');
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={label || t('shell.noAllocation')}>
        <g transform="rotate(-90 60 60)" fill="none" strokeWidth="10">
          <circle cx="60" cy="60" r={r} stroke="#1D1F24" />
          {total > 0 &&
            slices.map((s) => {
              const len = (s.value / total) * c;
              const dash = Math.max(0.5, len - gap);
              const el = <circle key={s.id} cx="60" cy="60" r={r} stroke={s.color} strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset} />;
              offset += len;
              return el;
            })}
        </g>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{center}</div>
    </div>
  );
}
