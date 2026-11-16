// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro identity: display type, ice light, the mark as an object, glass, and coin light.

import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Display face (Unbounded, bundled offline) with tabular figures. */
export const DISPLAY: CSSProperties = { fontFamily: "'Unbounded Variable', 'Geist Variable', sans-serif", fontWeight: 500, letterSpacing: '-0.04em', fontFeatureSettings: "'tnum' 1" };
/** Big thin figures: totals, balances, amounts. */
export const THIN: CSSProperties = { ...DISPLAY, fontWeight: 300, letterSpacing: '-0.035em' };
/** Small spaced capitals used for section labels. */
export const LABEL = 'text-[11px] font-medium uppercase tracking-[0.16em] text-faint';
/** Glass surface used by rows, fields and secondary buttons. */
/** A tinted surface, not a backdrop blur: a blur under every tile halved the frame rate while scrolling. */
export const GLASS_ROW = 'bg-[rgba(22,27,35,.72)] ring-1 ring-white/[.08]';
/** App background: a cold top, near-black bottom. */
export const BG = 'linear-gradient(180deg, #0e1826 0%, #0a0f16 48%, #07090d 100%)';

/** A coin colour pulled toward the cool grey of the UI, for lines and large areas. */
export function soft(hex: string, a = 0.78): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const c = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16);
  const m = (i: number) => Math.round(c(hex, i) * a + c('#c9d2dc', i) * (1 - a));
  return '#' + [1, 3, 5].map((i) => m(i).toString(16).padStart(2, '0')).join('');
}

/** Coin light: small figures take the coin's colour and glow. */
export const GLOW = (c: string): CSSProperties => ({ color: c, textShadow: `0 0 16px ${c}80, 0 0 2px ${c}55` });
/** Coin light for large figures. */
export const BIG = (c: string): CSSProperties => ({ color: c, textShadow: `0 0 34px ${c}66, 0 0 3px ${c}44` });

/** Light through ice: a cold light pool and caustic veins, strongest at (x, y). Drawn once. */
/** Cold light behind a screen. `veins` sets the ice veins apart from the light (default: same as `strength`). */
export function IceLight({ x = '50%', y = '30%', size = 900, strength = 1, veins, id = 'ice' }: { x?: string; y?: string; size?: number; strength?: number; veins?: number; id?: string }) {
  const mask = `radial-gradient(${size}px ${size * 0.62}px at ${x} ${y}, #000 0%, rgba(0,0,0,.55) 38%, transparent 72%)`;
  const f = `caustic-${id}`;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0" style={{ background: `radial-gradient(${size * 0.9}px ${size * 0.55}px at ${x} ${y}, rgba(124,196,255,${0.16 * strength}), rgba(124,196,255,${0.04 * strength}) 45%, transparent 75%)` }} />
      {/* The ice veins drift very slowly (kyro-drift, off under reduced motion), so the light feels alive. */}
      <svg className="kyro-drift absolute -inset-[6%] h-[112%] w-[112%]" style={{ WebkitMaskImage: mask, maskImage: mask, opacity: 0.32 * (veins ?? strength), mixBlendMode: 'screen' }}>
        <filter id={f} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.009 0.014" numOctaves="2" seed="4" />
          <feComponentTransfer>
            <feFuncR type="table" tableValues="0 0 0 0 0 0 .15 1 .15 0 0 0 0 0 0 0 0 0 0 0" />
            <feFuncG type="table" tableValues="0 0 0 0 0 0 .15 1 .15 0 0 0 0 0 0 0 0 0 0 0" />
            <feFuncB type="table" tableValues="0 0 0 0 0 0 .15 1 .15 0 0 0 0 0 0 0 0 0 0 0" />
            <feFuncA type="linear" slope="0" intercept="1" />
          </feComponentTransfer>
          <feGaussianBlur stdDeviation="0.45" />
          <feColorMatrix type="matrix" values="0 0 0 0 .62  0 0 0 0 .84  0 0 0 0 1  1 0 0 0 0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${f})`} />
      </svg>
      <div className="absolute inset-0" style={{ background: 'radial-gradient(1400px 900px at 50% 40%, transparent 60%, rgba(0,0,0,.38))' }} />
    </div>
  );
}

/** The Kyro mark as a physical object: a white frosted ring open on the right, a lit ice square. */
export function KyroObject({ size = 200 }: { size?: number }) {
  const t = size * 0.2;
  const ring = `radial-gradient(circle closest-side, transparent calc(100% - ${t}px), #000 calc(100% - ${t - 1}px), #000 99%, transparent 100%)`;
  const open = 'conic-gradient(from 130deg, #000 0 280deg, transparent 280deg)';
  const mask: CSSProperties = { WebkitMaskImage: `${ring}, ${open}`, WebkitMaskComposite: 'source-in', maskImage: `${ring}, ${open}`, maskComposite: 'intersect' };
  return (
    <div className="relative" style={{ width: size, height: size }} aria-hidden="true">
      <div className="absolute rounded-full" style={{ inset: -size * 0.35, background: 'radial-gradient(circle, rgba(124,196,255,.28), rgba(124,196,255,.06) 45%, transparent 70%)' }} />
      <div className="absolute inset-0" style={{ background: 'conic-gradient(from 150deg, #c4d3e1, #f5f8fb 16%, #ffffff 26%, #e3edf6 38%, #b9cde0 52%, #eef4fa 66%, #ffffff 78%, #d3e2ef 90%, #c4d3e1)', ...mask }} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 30% 22%, rgba(255,255,255,.65), transparent 32%), radial-gradient(circle at 72% 86%, rgba(124,196,255,.8), transparent 34%), radial-gradient(circle at 18% 70%, rgba(124,196,255,.35), transparent 30%)', mixBlendMode: 'overlay', ...mask }} />
      <div className="absolute grid place-items-center" style={{ inset: 0 }}>
        <IceSquare size={size * 0.24} />
      </div>
    </div>
  );
}

/** The lit ice square of the mark. */
export function IceSquare({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      className="block shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.05,
        background: 'linear-gradient(145deg, #f2f9ff 0%, #a9dbff 30%, #6fbaf8 62%, #3577b4 100%)',
        boxShadow: `0 0 ${size * 0.7}px rgba(124,196,255,.6), 0 0 ${size * 2}px rgba(124,196,255,.22), inset 0 1px 0 rgba(255,255,255,.9), inset 0 -${size * 0.12}px ${size * 0.25}px rgba(8,36,70,.45)`,
      }}
    />
  );
}

/** Small glowing ice square used as a marker (active section, Tor, notes). */
export function IceDot({ size = 5, className }: { size?: number; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block shrink-0 bg-ice shadow-[0_0_8px_#7cc4ff]', className)} style={{ width: size, height: size }} />;
}

export function Glass({ children, className, style }: { children?: ReactNode; className?: string | undefined; style?: CSSProperties | undefined }) {
  return (
    <div
      className={className}
      style={{
        background: 'linear-gradient(180deg, rgba(255,255,255,.068), rgba(255,255,255,.032)), rgba(12,16,22,.55)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.08), inset 0 0 0 1px rgba(255,255,255,.06), 0 24px 60px -30px rgba(0,0,0,.8)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Soft background glow in a coin's colour, placed behind a coin page. */
export function CoinGlow({ color, top = -40, width = 980, height = 440 }: { color: string; top?: number; width?: number; height?: number }) {
  return <div aria-hidden="true" className="pointer-events-none absolute left-1/2 -translate-x-1/2" style={{ top, width, height, background: `radial-gradient(closest-side, ${color}24, ${color}08 55%, transparent)` }} />;
}
