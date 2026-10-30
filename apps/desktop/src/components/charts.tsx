// SPDX-License-Identifier: GPL-3.0-or-later
// Charts: smooth Catmull-Rom curves (no angles), ice-blue line, dark-blue
// gradient 42 % → 0 %, hover dot + tooltip. Sparklines and allocation ring.

import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { areaPath, downsample, fitSeries, smoothPath } from '../lib/smooth';

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
      <svg width="100%" height={height} viewBox={`0 0 ${VB_W} ${height}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        <defs>
          <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2F6BFF" stopOpacity="0.42" />
            <stop offset="0.55" stopColor="#2F6BFF" stopOpacity="0.12" />
            <stop offset="1" stopColor="#2F6BFF" stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && <path d={area} fill={`url(#g${gid})`} />}
        {line && <path d={line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      {p && (
        <>
          <div aria-hidden="true" style={{ position: 'absolute', left: `${(p.x / VB_W) * 100}%`, top: 0, bottom: 0, borderLeft: '1px dashed rgba(124,196,255,.45)' }} />
          <div
            aria-hidden="true"
            style={{ position: 'absolute', left: `${(p.x / VB_W) * 100}%`, top: p.y, width: 12, height: 12, margin: '-6px 0 0 -6px', borderRadius: 999, background: stroke, boxShadow: '0 0 0 4px #101215, 0 0 0 9px rgba(124,196,255,.22)' }}
          />
          {tip && (
            <div
              style={{
                position: 'absolute',
                left: `clamp(100px, ${(p.x / VB_W) * 100}%, calc(100% - 100px))`,
                top: Math.max(0, p.y - 64),
                transform: 'translateX(-50%)',
              }}
              className="pointer-events-none flex flex-col items-center gap-px rounded-[8px] border border-line-3 bg-control px-2.5 py-1.5 whitespace-nowrap"
            >
              <span className="font-mono text-[10px] text-mute">{hover === null && defaultLabel ? `${tip.label} · ${defaultLabel}` : tip.label}</span>
              <span className="text-[13px] font-semibold">{tip.value}</span>
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
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export interface RingSlice {
  id: string;
  label: string;
  value: number;
  color: string;
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
