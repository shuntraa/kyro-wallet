// SPDX-License-Identifier: GPL-3.0-or-later
// The Kyro ring: the mark's open ring in glass, carrying coloured segments, with notes joined to
// their segment by a thin line and a small square, like a technical drawing.

import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { soft } from './brand';

export type Seg = { color: string; part: number; ice?: boolean; mute?: boolean };
export type Note = { seg: number; side: 'L' | 'R'; dy?: number; node: ReactNode; dot?: string };

const FROM = 130; // the opening sits on the right, as on the mark
const SPAN = 280;

function stops(segs: Seg[]): string {
  const total = segs.reduce((s, x) => s + Math.max(0, x.part), 0) || 1;
  const out: string[] = [];
  const gap = segs.length > 1 ? 1.8 : 0;
  let a = 0;
  segs.forEach((s, i) => {
    const len = (Math.max(0, s.part) / total) * SPAN;
    const a0 = a + (i ? gap / 2 : 0);
    const a1 = a + len - (i < segs.length - 1 ? gap / 2 : 0);
    const [c0, c1] = s.ice ? ['#f4f9fd', '#9fc9ec'] : s.mute ? [soft(s.color, 0.84), soft(s.color, 0.62)] : [soft(s.color, 0.98), soft(s.color, 0.8)];
    if (a1 > a0) out.push(`transparent ${a0}deg`, `${c0} ${a0}deg`, `${c1} ${a1}deg`, `transparent ${a1}deg`);
    a += len;
  });
  return `conic-gradient(from ${FROM}deg, ${out.join(', ') || 'transparent 0deg'}, transparent ${SPAN}deg)`;
}

/** Angle (conic degrees, 0 = up, clockwise) of the middle of segment `i`. */
export function midAngle(segs: Seg[], i: number): number {
  const total = segs.reduce((s, x) => s + Math.max(0, x.part), 0) || 1;
  const before = segs.slice(0, i).reduce((s, x) => s + Math.max(0, x.part), 0);
  return FROM + ((before + Math.max(0, segs[i]?.part ?? 0) / 2) / total) * SPAN;
}

export function VaultRing({ size, segs, halo = '#7cc4ff', glow = true, children }: { size: number; segs: Seg[]; halo?: string | undefined; glow?: boolean | undefined; children?: ReactNode }) {
  const t = size * 0.2;
  const ring = `radial-gradient(circle closest-side, transparent calc(100% - ${t}px), #000 calc(100% - ${t - 1}px), #000 99%, transparent 100%)`;
  const open = `conic-gradient(from ${FROM}deg, #000 0 ${SPAN}deg, transparent ${SPAN}deg)`;
  const mask: CSSProperties = { WebkitMaskImage: `${ring}, ${open}`, WebkitMaskComposite: 'source-in', maskImage: `${ring}, ${open}`, maskComposite: 'intersect' };
  const rim = `radial-gradient(circle closest-side, transparent calc(100% - ${t}px), rgba(255,255,255,.55) calc(100% - ${t - 1.2}px), transparent calc(100% - ${t - 7}px), transparent calc(100% - 8px), rgba(255,255,255,.4) calc(100% - 1.2px), transparent 100%)`;
  const bg = stops(segs);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div aria-hidden="true" className="absolute rounded-full" style={{ inset: -size * 0.32, background: `radial-gradient(circle, ${halo}2e, ${halo}0a 45%, transparent 70%)` }} />
      {glow && (
        <div aria-hidden="true" className="absolute inset-0" style={{ filter: `blur(${size * 0.06}px)`, opacity: 0.55 }}>
          <div className="absolute inset-0" style={{ background: bg, ...mask }} />
        </div>
      )}
      <div aria-hidden="true" className="absolute inset-0" style={{ background: bg, ...mask }} />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{ background: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,.7), transparent 34%), radial-gradient(circle at 74% 88%, rgba(124,196,255,.75), transparent 34%), radial-gradient(circle at 16% 72%, rgba(255,255,255,.25), transparent 30%)', mixBlendMode: 'overlay', ...mask }}
      />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: rim, WebkitMaskImage: open, maskImage: open }} />
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

/** Ring centred in a W×H stage, notes on both sides joined to their segment. */
export function Annotated({ W, H, size, segs, notes, halo, children }: { W: number; H: number; size: number; segs: Seg[]; notes: Note[]; halo?: string | undefined; children?: ReactNode }) {
  const cx = W / 2;
  const cy = H / 2;
  const R = size / 2 + 10;
  const col = size / 2 + 120;
  const lim = H / 2 - 24;
  const pts = notes.map((n) => {
    const th = (midAngle(segs, n.seg) * Math.PI) / 180;
    const at = (r: number) => ({ x: cx + r * Math.sin(th), y: cy - r * Math.cos(th) });
    const p = at(R);
    const e = at(R + 20);
    const dir = n.side === 'L' ? -1 : 1;
    return { n, p, e, dir, end: cx + dir * col, y: cy + (n.dy ?? Math.max(-lim, Math.min(lim, e.y - cy))) };
  });
  for (const side of [-1, 1]) {
    const s = pts.filter((q) => q.dir === side).sort((a, b) => a.y - b.y);
    for (let i = 1; i < s.length; i++) s[i]!.y = Math.max(s[i]!.y, s[i - 1]!.y + 56);
  }
  return (
    <div className="relative mx-auto" style={{ width: W, height: H }}>
      <svg aria-hidden="true" className="absolute inset-0" width={W} height={H}>
        {pts.map(({ p, e, end, y, n }, i) => (
          <g key={i}>
            <path d={`M${p.x},${p.y} L${e.x},${e.y} L${end},${y}`} fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="1" />
            <rect x={p.x - 3} y={p.y - 3} width="6" height="6" fill={n.dot ?? '#cfe7ff'} />
          </g>
        ))}
      </svg>
      <div className="absolute" style={{ left: cx - size / 2, top: cy - size / 2 }}>
        <VaultRing size={size} segs={segs} {...(halo ? { halo } : {})}>
          {children}
        </VaultRing>
      </div>
      {pts.map(({ n, end, y, dir }, i) => (
        <div key={i} className="absolute flex items-center" style={dir < 0 ? { right: W - end + 12, top: y, transform: 'translateY(-50%)' } : { left: end + 12, top: y, transform: 'translateY(-50%)' }}>
          {n.node}
        </div>
      ))}
    </div>
  );
}

/** Content of a ring note: an icon on the outer side, two lines of text. */
export function Side({ side, icon, children }: { side: 'L' | 'R'; icon: ReactNode; children: ReactNode }) {
  const text = (
    <span key="t" className={cn('flex flex-col gap-0.5 leading-tight', side === 'L' && 'items-end text-right')}>
      {children}
    </span>
  );
  const ic = <span key="i">{icon}</span>;
  return <span className="flex items-center gap-3 whitespace-nowrap">{side === 'L' ? [text, ic] : [ic, text]}</span>;
}

/** A note beside a block, joined to it by a line and a small square. */
export function NoteSide({ side, title, children }: { side: 'L' | 'R'; title: ReactNode; children?: ReactNode }) {
  const line = <span key="l" className="h-px w-12 shrink-0 bg-white/[.18]" />;
  const sq = <span key="s" className="size-[6px] shrink-0 bg-[#cfe7ff]" />;
  const text = (
    <span key="t" className={cn('flex max-w-[230px] flex-col gap-0.5 text-[12.5px] leading-snug text-mute', side === 'L' && 'items-end text-right')}>
      <span className="text-[13px] font-semibold text-text">{title}</span>
      {children}
    </span>
  );
  return <span className={cn('flex items-center gap-3', side === 'L' ? 'justify-end pr-4' : 'pl-4')}>{side === 'L' ? [text, line, sq] : [sq, line, text]}</span>;
}

/** A centred column row with optional notes on the left and right (hidden on narrow windows). */
export function NoteRow({ left, right, w = 440, className, children }: { left?: ReactNode; right?: ReactNode; w?: number; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid items-center', className)} style={{ gridTemplateColumns: `minmax(0,1fr) minmax(0,${w}px) minmax(0,1fr)` }}>
      <span className="hidden min-w-0 xl:block">{left}</span>
      <div className="col-start-2 min-w-0">{children}</div>
      <span className="hidden min-w-0 xl:block">{right}</span>
    </div>
  );
}
