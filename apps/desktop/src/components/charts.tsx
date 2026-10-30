// SPDX-License-Identifier: GPL-3.0-or-later
// Charts: smooth Catmull-Rom curves (no angles), ice-blue line drawn from the left on mount,
// a faint ice wash under it, hover crosshair + tooltip. Sparklines, allocation bar and ring.

import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { areaPath, downsample, fitSeries, smoothPath } from '../lib/smooth';
import { EASE_OUT } from './motion';

const VB_W = 1000;

export interface SmoothChartProps {
  values: number[];
  times?: number[];
  height: number;
  /** Tooltip label for a point. */
  renderTooltip?: (i: number) => { label: string; value: string };
  /** Which point to show when not hovering. */
  defaultPoint?: 'last' | 'max' | 'none';
  defaultLabel?: string;
  padTop?: number;
  padBottom?: number;
  ariaLabel: string;
  className?: string;
  stroke?: string;
}

export function SmoothChart({ values, height, renderTooltip, defaultPoint = 'last', defaultLabel, padTop = 24, padBottom = 18, ariaLabel, className, stroke = '#7CC4FF' }: SmoothChartProps) {
  const gid = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const data = useMemo(() => downsample(values, 240), [values]);
  const ratio = values.length > 1 ? (values.length - 1) / Math.max(1, data.length - 1) : 1;
  const pts = useMemo(() => fitSeries(data, { width: VB_W, height, padTop, padBottom }), [data, height, padTop, padBottom]);
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
  const tip = idx !== null && renderTooltip ? renderTooltip(Math.min(values.length - 1, Math.round(idx * ratio))) : null;

  const onMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || pts.length === 0) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(pts.length - 1, Math.round(x * (pts.length - 1)))));
  };

  return (
    <div ref={ref} className={className} style={{ position: 'relative', height }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg width="100%" height={height} viewBox={`0 0 ${VB_W} ${height}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel} className="chart-reveal">
        <defs>
          <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity="0.16" />
            <stop offset="0.6" stopColor={stroke} stopOpacity="0.04" />
            <stop offset="1" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && <path d={area} fill={`url(#g${gid})`} />}
        {line && <path d={line} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      {p && (
        <>
          <div aria-hidden="true" style={{ position: 'absolute', left: `${(p.x / VB_W) * 100}%`, top: 0, bottom: 0, borderLeft: '1px solid rgba(124,196,255,.22)' }} />
          <div
            aria-hidden="true"
            className="fade-in"
            style={{ position: 'absolute', left: `${(p.x / VB_W) * 100}%`, top: p.y, width: 9, height: 9, margin: '-4.5px 0 0 -4.5px', borderRadius: 999, background: '#090a0c', border: `2px solid ${stroke}`, transition: 'top 120ms ease-out' }}
          />
          {tip && (
            <div
              style={{
                position: 'absolute',
                left: `clamp(100px, ${(p.x / VB_W) * 100}%, calc(100% - 100px))`,
                top: Math.max(0, p.y - 64),
                transform: 'translateX(-50%)',
              }}
              className="pointer-events-none flex flex-col items-center gap-px rounded-ctl border border-line-2 bg-[#121418]/95 px-2.5 py-1.5 whitespace-nowrap"
            >
              <span className="font-mono text-[10px] tracking-[0.04em] text-faint">{hover === null && defaultLabel ? `${tip.label} · ${defaultLabel}` : tip.label}</span>
              <span className="text-[13px] font-medium">{tip.value}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function Sparkline({ values, color, width = 96, height = 28 }: { values: number[]; color: string; width?: number; height?: number }) {
  const d = useMemo(() => smoothPath(fitSeries(downsample(values, 32), { width: width - 4, height, padTop: 4, padBottom: 4 }).map((p) => ({ x: p.x + 2, y: p.y }))), [values, width, height]);
  if (!d) return <span style={{ width, height }} className="inline-block" />;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
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
    <div role="img" aria-label={label || 'Aucune répartition'} className={`flex h-2 w-full gap-[2px] overflow-hidden rounded-[2px] bg-control ${className ?? ''}`}>
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
      <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={label || 'Aucune répartition'}>
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
