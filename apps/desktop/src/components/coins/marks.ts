// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro's own coin icon set: a lit disc derived from the asset's colour plus a simplified,
// hand-drawn geometric mark (24-unit grid).

/** One drawn shape of a mark, in the 24 × 24 grid. */
export interface Shape {
  d: string;
  w?: number;
  tone?: 'ink' | 'soft' | 'accent' | 'cut';
  o?: number;
  evenodd?: boolean;
  tf?: string;
  butt?: boolean;
}

export interface MarkDef {
  name: string;
  color: string;
  base?: readonly [string, string];
  ink?: string;
  accent?: string;
  scale?: number;
  transform?: string;
  shapes: Shape[];
}

const n = (v: number) => String(Math.round(v * 100) / 100);
const P = (pts: readonly (readonly [number, number])[]) => 'M' + pts.map(([x, y]) => `${n(x)} ${n(y)}`).join('L') + 'Z';
const R = (x: number, y: number, w: number, h: number) => P([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const E = (cx: number, cy: number, rx: number, ry = rx) =>
  `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0Z`;
const at = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
};
const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const [x0, y0] = at(cx, cy, r, a0);
  const [x1, y1] = at(cx, cy, r, a1);
  return `M${n(x0)} ${n(y0)}A${n(r)} ${n(r)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${n(x1)} ${n(y1)}`;
};
const hexPts = (cx: number, cy: number, r: number, rot = 0) => Array.from({ length: 6 }, (_, i) => at(cx, cy, r, rot + i * 60));
const line = (pts: readonly (readonly [number, number])[]) => 'M' + pts.map(([x, y]) => `${n(x)} ${n(y)}`).join('L');

const fill = (d: string, o: Omit<Shape, 'd'> = {}): Shape => ({ d, ...o });
const stroke = (d: string, w: number, o: Omit<Shape, 'd' | 'w'> = {}): Shape => ({ d, w, ...o });

function bShapes(tone: Shape['tone'] = 'ink'): Shape[] {
  const body =
    'M7.2 5.6H13.9C16.1 5.6 17.3 6.9 17.3 8.7C17.3 10 16.6 11 15.5 11.4C17 11.8 18 13.1 18 14.7C18 16.9 16.5 18.4 14.1 18.4H7.2Z' +
    'M9.9 7.9H13.5C14.3 7.9 14.8 8.5 14.8 9.25C14.8 10 14.3 10.6 13.5 10.6H9.9Z' +
    'M9.9 12.9H13.8C14.8 12.9 15.4 13.6 15.4 14.5C15.4 15.4 14.8 16.1 13.8 16.1H9.9Z';
  const ticks = R(9.6, 3.5, 1.7, 2.5) + R(12.4, 3.5, 1.7, 2.5) + R(9.6, 18, 1.7, 2.5) + R(12.4, 18, 1.7, 2.5) + R(5.5, 5.6, 2, 2.1) + R(5.5, 16.3, 2, 2.1);
  return [fill(body, { evenodd: true, tone }), fill(ticks, { tone })];
}

const D_OUTER = 'M7.4 5.2H12.2C16.6 5.2 19.2 8.1 19.2 12C19.2 15.9 16.6 18.8 12.2 18.8H7.4Z';
const D_HOLE = 'M10.1 7.8H12.1C14.8 7.8 16.4 9.5 16.4 12C16.4 14.5 14.8 16.2 12.1 16.2H10.1Z';

const ETH_SHAPES: Shape[] = [
  fill(P([[12, 2.6], [5.6, 12.3], [12, 9.5]])),
  fill(P([[12, 2.6], [18.4, 12.3], [12, 9.5]]), { tone: 'soft', o: 0.72 }),
  fill(P([[5.6, 12.3], [12, 9.5], [12, 15.9]]), { tone: 'soft', o: 0.86 }),
  fill(P([[18.4, 12.3], [12, 9.5], [12, 15.9]]), { tone: 'soft', o: 0.56 }),
  fill(P([[5.6, 13.8], [12, 17.6], [12, 21.4]])),
  fill(P([[18.4, 13.8], [12, 17.6], [12, 21.4]]), { tone: 'soft', o: 0.72 }),
];

function bands(cx: number, cy: number, r: number, cuts: number[], gap: number): string {
  const edges: number[] = [cy - r];
  for (const c of cuts) edges.push(cy + c - gap / 2, cy + c + gap / 2);
  edges.push(cy + r);
  let d = '';
  for (let i = 0; i < edges.length; i += 2) {
    const y0 = edges[i] ?? 0;
    const y1 = edges[i + 1] ?? 0;
    const w0 = Math.sqrt(Math.max(0, r * r - (y0 - cy) ** 2));
    const w1 = Math.sqrt(Math.max(0, r * r - (y1 - cy) ** 2));
    d += `M${n(cx - w0)} ${n(y0)}L${n(cx + w0)} ${n(y0)}A${n(r)} ${n(r)} 0 0 1 ${n(cx + w1)} ${n(y1)}L${n(cx - w1)} ${n(y1)}A${n(r)} ${n(r)} 0 0 1 ${n(cx - w0)} ${n(y0)}Z`;
  }
  return d;
}

function dotRing(cx: number, cy: number, R0: number, r: number, count: number, offset: number): string {
  let d = '';
  for (let i = 0; i < count; i++) {
    const [x, y] = at(cx, cy, R0, offset + (360 / count) * i);
    d += E(x, y, r);
  }
  return d;
}

const DARK = (a: string, b: string) => [a, b] as const;

export const MARKS = {
  btc: { name: 'Bitcoin', color: '#F7931A', transform: 'rotate(14 12 12) translate(-0.6 0)', shapes: bShapes() },
  eth: { name: 'Ethereum', color: '#627EEA', scale: 1.66, shapes: ETH_SHAPES },
  sol: {
    name: 'Solana',
    color: '#35D0BA',
    base: ['#9A4BFF', '#12C9A0'],
    shapes: [
      fill(P([[7.6, 5.4], [19.4, 5.4], [16.6, 8.6], [4.6, 8.6]])),
      fill(P([[4.6, 10.4], [16.4, 10.4], [19.4, 13.6], [7.4, 13.6]])),
      fill(P([[7.6, 15.4], [19.4, 15.4], [16.6, 18.6], [4.6, 18.6]])),
    ],
  },
  bnb: {
    name: 'BNB',
    color: '#F0B90B',
    base: ['#F6C933', '#D99A06'],
    scale: 1.66,
    shapes: [
      fill(
        P([[12, 9.6], [14.4, 12], [12, 14.4], [9.6, 12]]) +
          P([[5.6, 10], [7.6, 12], [5.6, 14], [3.6, 12]]) +
          P([[18.4, 10], [20.4, 12], [18.4, 14], [16.4, 12]]) +
          P([[12, 3.4], [17.4, 8.8], [15.7, 10.5], [12, 6.8], [8.3, 10.5], [6.6, 8.8]]) +
          P([[12, 20.6], [17.4, 15.2], [15.7, 13.5], [12, 17.2], [8.3, 13.5], [6.6, 15.2]]),
      ),
    ],
  },
  trx: {
    name: 'TRON',
    color: '#EB0029',
    shapes: [stroke(P([[4.6, 4.8], [19.6, 8.6], [11.2, 20.2]]), 1.9), stroke(line([[4.6, 4.8], [14.2, 10.8], [11.2, 20.2]]), 1.5), stroke(line([[14.2, 10.8], [19.6, 8.6]]), 1.5)],
  },
  xrp: {
    name: 'XRP',
    color: '#23292F',
    base: DARK('#48505B', '#16191D'),
    shapes: [
      stroke('M5.2 5.2L8.9 8.8C10.6 10.5 13.4 10.5 15.1 8.8L18.8 5.2', 2.4),
      stroke('M5.2 18.8L8.9 15.2C10.6 13.5 13.4 13.5 15.1 15.2L18.8 18.8', 2.4),
    ],
  },
  ada: {
    name: 'Cardano',
    color: '#2A5BD7',
    scale: 1.66,
    shapes: [fill(dotRing(12, 12, 3.5, 1.35, 6, 0) + dotRing(12, 12, 6.5, 1.05, 6, 30) + dotRing(12, 12, 9.2, 0.72, 12, 0))],
  },
  doge: {
    name: 'Dogecoin',
    color: '#C2A633',
    base: ['#DDBF4A', '#A8891E'],
    transform: 'translate(-0.5 0)',
    shapes: [fill(D_OUTER + D_HOLE, { evenodd: true }), fill(R(4.8, 10.85, 7.8, 2.3))],
  },
  ltc: {
    name: 'Litecoin',
    color: '#345D9D',
    shapes: [fill('M10 4.6H12.9L11 15.9H18.4L17.9 18.8H7.4Z'), fill(P([[5, 13.4], [14.8, 9.6], [14.4, 12], [4.6, 15.8]]))],
  },
  bch: { name: 'Bitcoin Cash', color: '#0AC18E', transform: 'rotate(-28 12 12) translate(-0.6 0)', shapes: bShapes() },
  dash: {
    name: 'Dash',
    color: '#008CE7',
    shapes: [
      fill('M8.6 6H18.4C19.8 6 20.6 7.1 20.2 8.4L18.4 15.6C18.1 17 16.9 18 15.5 18H5.2L5.8 15.4H15.6L17.2 8.6H8Z'),
      fill(P([[5.2, 10.8], [12.6, 10.8], [12, 13.2], [4.6, 13.2]])),
    ],
  },
  xlm: {
    name: 'Stellar',
    color: '#2B3040',
    base: DARK('#4A5164', '#121520'),
    shapes: [stroke(arc(12, 12, 6.8, 300, 600), 1.8), stroke(line([[3.6, 15.2], [20.4, 7.6]]), 1.8), stroke(line([[3.6, 18.4], [20.4, 10.8]]), 1.8)],
  },
  near: {
    name: 'NEAR',
    color: '#1E2124',
    base: DARK('#3A3F45', '#0D0F11'),
    ink: '#00EC97',
    shapes: [stroke('M7 18.2V10.4', 2.7), stroke('M17 5.8V13.6', 2.7), stroke('M7 5.9L17 18.1', 2.7)],
  },
  sui: {
    name: 'Sui',
    color: '#4DA2FF',
    shapes: [
      stroke('M12 3.6C12 3.6 17.8 9.6 17.8 14.4C17.8 17.8 15.2 20.4 12 20.4C8.8 20.4 6.2 17.8 6.2 14.4C6.2 9.6 12 3.6 12 3.6Z', 2),
      stroke('M8.8 15.6C10.2 13.4 11.8 16.9 13.6 14.6C14.4 13.6 15 13.3 15.4 13.4', 1.7),
    ],
  },
  pol: {
    name: 'Polygon',
    color: '#8247E5',
    shapes: (() => {
      const L = hexPts(8.6, 13.6, 4.6);
      const Rr = hexPts(15.4, 10.4, 4.6);
      const pick = (h: [number, number][], idx: number[]) => idx.map((i): [number, number] => h[i] ?? [0, 0]);
      return [stroke(line(pick(L, [1, 0, 5, 4, 3, 2])), 2.2), stroke(line(pick(Rr, [4, 3, 2, 1, 0, 5])), 2.2)];
    })(),
  },
  arb: {
    name: 'Arbitrum',
    color: '#213147',
    base: DARK('#33507A', '#131F33'),
    accent: '#3DB2FF',
    shapes: [
      stroke(P(hexPts(12, 12, 9)), 1.6),
      stroke('M7.6 16.8L11.3 8.6', 2.3),
      stroke('M12.8 8.6L16.6 16.8', 2.3, { tone: 'accent' }),
      stroke('M14.4 12.2L12.6 16.8', 1.8, { tone: 'accent' }),
    ],
  },
  op: {
    name: 'Optimism',
    color: '#FF0420',
    transform: 'translate(2.0 0) skewX(-12)',
    shapes: [
      fill(E(8.3, 12, 3.6, 4.7) + E(8.3, 12, 1.35, 2.5), { evenodd: true }),
      fill('M13.1 7.3H17C19.1 7.3 20.3 8.5 20.3 10.4C20.3 12.3 19.1 13.5 17 13.5H15.5V16.7H13.1ZM15.5 9.3H16.8C17.6 9.3 18 9.75 18 10.4C18 11.05 17.6 11.5 16.8 11.5H15.5Z', { evenodd: true }),
    ],
  },
  base: {
    name: 'Base',
    color: '#0052FF',
    shapes: [fill('M4.27 10.7A7.8 7.8 0 1 1 4.27 13.3H13V10.7Z')],
  },
  avax: {
    name: 'Avalanche',
    color: '#E84142',
    shapes: [
      fill(P([[11.6, 4.6], [14.6, 9.9], [10.1, 18.4], [4.4, 18.4]]), { o: 1 }),
      stroke(P([[11.6, 4.6], [14.6, 9.9], [10.1, 18.4], [4.4, 18.4]]), 1),
      fill(P([[16.7, 12.4], [19.6, 18.4], [13.6, 18.4]])),
      stroke(P([[16.7, 12.4], [19.6, 18.4], [13.6, 18.4]]), 1),
    ],
  },
  cro: {
    name: 'Cronos',
    color: '#0F3C6E',
    base: DARK('#285C97', '#0B2547'),
    shapes: [stroke(P(hexPts(12, 12, 8.6)), 1.8), fill(P([[7.4, 10.6], [12, 13.2], [16.6, 10.6], [16.6, 14.6], [12, 17.2], [7.4, 14.6]]), { tone: 'soft', o: 0.9 })],
  },
  mnt: {
    name: 'Mantle',
    color: '#1C2B2A',
    base: DARK('#3B5250', '#0D1716'),
    ink: '#8BE3D8',
    shapes: [
      ...Array.from({ length: 8 }, (_, i) => stroke(arc(12, 12, 7.6, i * 45 + 8, i * 45 + 37), 2.4, { butt: true })),
      fill(E(12, 12, 2.6)),
    ],
  },
  sonic: {
    name: 'Sonic',
    color: '#13306B',
    base: DARK('#2A55A8', '#0D1F48'),
    accent: '#FF9C55',
    shapes: [stroke(E(12, 12, 7.8), 2), stroke('M4.6 13.4C8.4 9.2 15.6 9.2 19.4 13.4', 2.2, { tone: 'accent' })],
  },
  flr: {
    name: 'Flare',
    color: '#E62058',
    shapes: [stroke('M6 7.2H17.8', 3.2), stroke('M6 12.4H13.2', 3.2), fill(E(6.4, 17.6, 1.75))],
    transform: 'translate(0.4 0)',
  },
  kaia: {
    name: 'Kaia',
    color: '#1F2219',
    base: DARK('#3A4030', '#0C0E09'),
    ink: '#C2F21A',
    shapes: [fill(R(6.2, 5.2, 2.9, 13.6)), fill(P([[11, 12], [16.2, 5.2], [19.8, 5.2], [14.6, 12]])), fill(P([[11, 12], [14.6, 12], [19.8, 18.8], [16.2, 18.8]]))],
  },
  gno: {
    name: 'Gnosis',
    color: '#3E6957',
    shapes: [stroke(E(8.7, 13.4, 3.3) + E(15.3, 13.4, 3.3), 1.9), fill(E(9.3, 13.8, 1.15) + E(15.9, 13.8, 1.15)), stroke(line([[5, 7.4], [12, 10.2], [19, 7.4]]), 1.9)],
  },
  hype: {
    name: 'Hyperliquid',
    color: '#0B2E2A',
    base: DARK('#1E5A52', '#062320'),
    ink: '#9AFBE4',
    shapes: [fill('M3.8 12C3.8 7.2 8 5.8 10.6 9C11.4 10 12.6 10 13.4 9C16 5.8 20.2 7.2 20.2 12C20.2 16.8 16 18.2 13.4 15C12.6 14 11.4 14 10.6 15C8 18.2 3.8 16.8 3.8 12Z')],
  },
  sei: {
    name: 'Sei',
    color: '#9E1F19',
    shapes: [stroke(E(12, 12, 7.8), 1.9), stroke('M4.6 12.6C7 9.8 9.4 9.8 12 12.6C14.6 15.4 17 15.4 19.4 12.6', 1.9)],
  },
  cfx: {
    name: 'Conflux',
    color: '#26272A',
    base: DARK('#46484D', '#111214'),
    accent: '#38A1DB',
    shapes: [stroke(line([[4.4, 18.2], [12, 5], [19.6, 18.2]]), 2.2), stroke(line([[8.6, 18.2], [12, 12.2], [15.4, 18.2]]), 2.2, { tone: 'accent' })],
  },
  usdt: {
    name: 'Tether',
    color: '#26A17B',
    shapes: [fill(R(5, 5, 14, 3)), fill(R(10.55, 7.6, 2.9, 11.6)), stroke(E(12, 11.7, 7.2, 2.1), 1.35)],
  },
  usdc: {
    name: 'USD Coin',
    color: '#2775CA',
    scale: 1.64,
    shapes: [
      stroke(arc(12, 12, 9, 212, 328), 1.8),
      stroke(arc(12, 12, 9, 32, 148), 1.8),
      stroke('M15 9.3C14.6 8.2 13.5 7.6 12 7.6C10.3 7.6 9.1 8.5 9.1 9.8C9.1 12.8 15 11.4 15 14.3C15 15.6 13.8 16.4 12 16.4C10.5 16.4 9.4 15.8 9 14.7', 1.8),
      stroke('M12 5.6V7.4M12 16.6V18.4', 1.8),
    ],
  },
  dai: {
    name: 'Dai',
    color: '#F5AC37',
    base: ['#F8BE55', '#DE8E14'],
    transform: 'translate(-0.3 0)',
    shapes: [fill(D_OUTER + D_HOLE, { evenodd: true }), fill(R(4.6, 9.7, 16, 1.6) + R(4.6, 12.7, 16, 1.6))],
  },
  wbtc: {
    name: 'Wrapped Bitcoin',
    color: '#5A5564',
    base: DARK('#6E6879', '#2A2731'),
    accent: '#F7931A',
    shapes: [
      ...bShapes('accent').map((s) => ({ ...s, tf: 'translate(12 12) rotate(14) scale(0.68) translate(-12.6 -12)' })),
      stroke(arc(12, 12, 9.4, 205, 335), 1.6),
      stroke(arc(12, 12, 9.4, 25, 155), 1.6),
    ],
  },
  etc: {
    name: 'Ethereum Classic',
    color: '#3AB83A',
    base: ['#5FCB5A', '#1F7F2A'],
    scale: 1.66,
    shapes: [
      fill(P([[12, 2.6], [6.4, 10.4], [12, 8.2]])),
      fill(P([[12, 2.6], [17.6, 10.4], [12, 8.2]]), { tone: 'soft', o: 0.72 }),
      fill(P([[5.4, 11.9], [12, 9.3], [18.6, 11.9], [12, 14.5]]), { tone: 'soft', o: 0.86 }),
      fill(P([[6.4, 13.6], [12, 15.9], [12, 21.4]])),
      fill(P([[17.6, 13.6], [12, 15.9], [12, 21.4]]), { tone: 'soft', o: 0.72 }),
    ],
  },
  weth: {
    name: 'Wrapped Ether',
    color: '#4A4E5C',
    base: DARK('#646A7C', '#22252E'),
    accent: '#8FA4F5',
    shapes: [
      ...ETH_SHAPES.map((s) => ({ ...s, tf: 'translate(12 12) scale(0.66) translate(-12 -12)' })),
      stroke(arc(12, 12, 9.4, 205, 335), 1.6, { tone: 'accent' }),
      stroke(arc(12, 12, 9.4, 25, 155), 1.6, { tone: 'accent' }),
    ],
  },
  steth: {
    name: 'Lido Staked Ether',
    color: '#00A3FF',
    base: ['#4CC2FF', '#0A6FD1'],
    shapes: [
      stroke(P([[12, 3.4], [18, 12], [12, 20.6], [6, 12]]), 1.7),
      fill(P([[12, 7.6], [15, 12], [12, 16.4], [9, 12]])),
      fill(P([[12, 7.6], [15, 12], [12, 12]]), { tone: 'cut', o: 1 }),
    ],
  },
  link: { name: 'Chainlink', color: '#2A5ADA', shapes: [stroke(P(hexPts(12, 12, 7.8)), 2.8)] },
  uni: {
    name: 'Uniswap',
    color: '#FF007A',
    base: ['#FF4FA6', '#D4005F'],
    shapes: [
      fill(
        'M9.6 4.8L12.4 7.4C14.6 7.6 16 9 17 10.8L18.8 13.6C19.2 14.3 18.8 15.1 18 15.2L15.2 15.4C14.4 15.4 13.8 15.9 13.8 16.7V19.6H6.4C6.9 17.4 7.4 15.2 7 12.8C6.6 10.4 7.4 8.4 9.4 7.4Z' +
          E(13.6, 10.9, 0.95),
        { evenodd: true },
      ),
      fill(P([[12.6, 7.6], [17.2, 3.4], [14.2, 8.4]])),
    ],
  },
  aave: {
    name: 'Aave',
    color: '#B6509E',
    base: ['#B6509E', '#2EBAC6'],
    shapes: [stroke(line([[5, 18.6], [12, 4.8], [19, 18.6]]), 2.6), fill(E(9.9, 15.2, 1.25) + E(14.1, 15.2, 1.25))],
  },
  shib: {
    name: 'Shiba Inu',
    color: '#F2780C',
    base: ['#FFA41B', '#DB3F0A'],
    shapes: [
      fill('M4.2 4.2L9 8.2H15L19.8 4.2L20.2 11.6C20.2 13.4 19.4 14.8 18 16L12 20.2L6 16C4.6 14.8 3.8 13.4 3.8 11.6Z' + E(8.9, 12, 1.2) + E(15.1, 12, 1.2) + P([[10.7, 15.2], [13.3, 15.2], [12, 16.8]]), {
        evenodd: true,
      }),
    ],
  },
  pepe: {
    name: 'Pepe',
    color: '#3D9E3A',
    shapes: [
      fill(E(8.2, 9.6, 3.5) + E(15.8, 9.6, 3.5)),
      fill(E(9, 10.1, 1.55) + E(16.6, 10.1, 1.55), { tone: 'cut' }),
      stroke('M5.6 15.4C8.8 18.6 15.2 18.6 18.4 15.4', 2),
    ],
  },
  qnt: {
    name: 'Quant',
    color: '#3A4046',
    base: DARK('#5A636C', '#191C1F'),
    shapes: [fill(E(11.4, 11.4, 7.2) + E(11.4, 11.4, 4.5), { evenodd: true }), fill(P([[13.4, 14.8], [15.4, 12.8], [20.2, 17.8], [18.2, 19.8]]))],
  },
  xmr: { name: 'Monero', color: '#FF6600', shapes: [fill('M4.4 17.6V6.6L12 14.2L19.6 6.6V17.6H16.8V12.6L12 17.4L7.2 12.6V17.6Z')] },
  gram: {
    name: 'Gram',
    color: '#0098EA',
    shapes: [
      fill(
        'M6.3 6.4H17.7C18.9 6.4 19.6 7.7 19 8.7L12.9 19C12.5 19.7 11.5 19.7 11.1 19L5 8.7C4.4 7.7 5.1 6.4 6.3 6.4Z' + P([[7.8, 8.7], [10.9, 8.7], [10.9, 15.4]]) + P([[13.1, 8.7], [16.2, 8.7], [13.1, 15.4]]),
        { evenodd: true },
      ),
    ],
  },
  atom: {
    name: 'Cosmos',
    color: '#2E3148',
    base: DARK('#4A4E78', '#171930'),
    shapes: [
      stroke(E(12, 12, 9, 3.2), 1.5),
      stroke(E(12, 12, 9, 3.2), 1.5, { tf: 'rotate(60 12 12)' }),
      stroke(E(12, 12, 9, 3.2), 1.5, { tf: 'rotate(120 12 12)' }),
      fill(E(12, 12, 1.9)),
    ],
  },
  dot: {
    name: 'Polkadot',
    color: '#E6007A',
    shapes: Array.from({ length: 6 }, (_, i) => fill(E(12, 4.8, 2.7, 2.05), { tf: `rotate(${i * 60} 12 12)` })),
  },
  apt: {
    name: 'Aptos',
    color: '#24262B',
    base: DARK('#474B53', '#0F1013'),
    shapes: [fill(bands(12, 12, 8, [-3.4, 0, 3.4], 1.25))],
  },
  algo: {
    name: 'Algorand',
    color: '#26282C',
    base: DARK('#4A4D53', '#101113'),
    shapes: [
      fill(P([[4.4, 19.2], [12.6, 4.8], [15.4, 4.8], [7.6, 19.2]])),
      fill(P([[14.4, 6.6], [16, 6.6], [19.8, 19.2], [17.9, 19.2]])),
      fill(P([[12.4, 13.1], [13.6, 11.1], [16.4, 19.2], [14.6, 19.2]])),
    ],
  },
  kas: {
    name: 'Kaspa',
    color: '#49C2B0',
    base: ['#6FD8C8', '#23998A'],
    transform: 'rotate(12 12 12)',
    shapes: [fill(R(7.4, 4.6, 2.8, 14.8)), stroke('M9.2 12L17.4 5.8M9.2 12L17.4 18.2', 2.8)],
  },
  zec: {
    name: 'Zcash',
    color: '#F4B728',
    base: ['#F8C94E', '#DE9A0E'],
    ink: '#231F20',
    shapes: [
      fill(P([[7.4, 7], [16.6, 7], [16.6, 9.3], [10.9, 14.7], [16.6, 14.7], [16.6, 17], [7.4, 17], [7.4, 14.7], [13.1, 9.3], [7.4, 9.3]])),
      fill(R(10.85, 4.2, 2.3, 3) + R(10.85, 16.8, 2.3, 3)),
    ],
  },
  hbar: {
    name: 'Hedera',
    color: '#26272B',
    base: DARK('#4A4B51', '#0F1012'),
    shapes: [fill(R(6.4, 4.8, 2.6, 14.4) + R(15, 4.8, 2.6, 14.4) + R(9, 8.8, 6, 2) + R(9, 13.2, 6, 2))],
  },
} satisfies Record<string, MarkDef>;

export type MarkKey = keyof typeof MARKS;

/** Ticker, CoinGecko id and chain key → mark (lowercase keys). */
const ALIASES: Record<string, MarkKey> = {
  bitcoin: 'btc',
  ethereum: 'eth', sepolia: 'eth',
  'ethereum-classic': 'etc',
  'wrapped-ether': 'weth', 'wrapped-eth': 'weth',
  'staked-ether': 'steth', 'lido-staked-ether': 'steth', wsteth: 'steth',
  solana: 'sol',
  bnb: 'bnb', bsc: 'bnb', binancecoin: 'bnb', 'bnb-chain': 'bnb',
  tron: 'trx',
  ripple: 'xrp',
  cardano: 'ada',
  dogecoin: 'doge',
  litecoin: 'ltc',
  'bitcoin-cash': 'bch', bitcoincash: 'bch',
  stellar: 'xlm',
  near: 'near',
  sui: 'sui',
  polygon: 'pol', matic: 'pol', 'matic-network': 'pol', 'polygon-ecosystem-token': 'pol',
  arbitrum: 'arb',
  optimism: 'op',
  avalanche: 'avax', 'avalanche-2': 'avax',
  cronos: 'cro', 'crypto-com-chain': 'cro',
  mantle: 'mnt',
  s: 'sonic', 'sonic-3': 'sonic',
  flare: 'flr', 'flare-networks': 'flr',
  gnosis: 'gno', xdai: 'gno',
  hyperliquid: 'hype', hyperevm: 'hype',
  'sei-network': 'sei',
  conflux: 'cfx', 'conflux-token': 'cfx',
  tether: 'usdt',
  'usd-coin': 'usdc',
  'wrapped-bitcoin': 'wbtc',
  chainlink: 'link',
  uniswap: 'uni',
  'shiba-inu': 'shib',
  'quant-network': 'qnt',
  monero: 'xmr',
  'the-open-network': 'gram', toncoin: 'gram', ton: 'gram',
  cosmos: 'atom',
  polkadot: 'dot',
  aptos: 'apt',
  algorand: 'algo',
  kaspa: 'kas',
  zcash: 'zec',
  hedera: 'hbar', 'hedera-hashgraph': 'hbar',
};

const GLYPHS: Record<string, MarkKey> = { 'Ξ': 'eth', 'Ł': 'ltc', 'Ð': 'doge', '₮': 'usdt' };

function lookup(k: string | undefined): MarkKey | undefined {
  if (!k) return undefined;
  const s = k.trim().toLowerCase();
  if (s in MARKS) return s as MarkKey;
  return ALIASES[s];
}

/**
 * Mark for an asset: by id (`btc`, `eth:42161`, `cg:bitcoin`, a CoinGecko id, a chain key), then by
 * ticker, then by glyph.
 */
export function resolveMark(q: { id?: string | undefined; symbol?: string | undefined; glyph?: string | undefined }): MarkKey | undefined {
  const id = q.id?.trim().toLowerCase();
  if (id) {
    const bare = id.startsWith('cg:') ? id.slice(3) : id;
    if (/^eth:\d+$/.test(bare)) return 'eth';
    if (!/^(erc20|spl|trc20):/.test(bare)) {
      const m = lookup(bare);
      if (m) return m;
    }
  }
  return lookup(q.symbol) ?? (q.glyph ? GLYPHS[q.glyph] : undefined);
}

const TICKER_COLORS: Record<string, string> = {
  ICP: '#29ABE2', FIL: '#0090FF', VET: '#15BDFF', INJ: '#0082FA', MKR: '#1AAB9B', GRT: '#6747ED', SAND: '#00ADEF',
  MANA: '#FF2D55', XTZ: '#2C7DF7', LDO: '#F69988', TAO: '#3A3A3A', OKB: '#3A3A3A', LEO: '#F6A21E', BGB: '#00B8D9', ENA: '#3A3A3A',
  USDE: '#3A3A3A', ONDO: '#1B2B4D', RENDER: '#E8433E', FET: '#1D2E54', IMX: '#17B5CB', STX: '#5546FF', THETA: '#2AB8E6',
  EGLD: '#23F7DD', XDC: '#2A4BA0', BONK: '#F8A626', WIF: '#A0715A', FLOKI: '#E58E26', JUP: '#2CB67D', PYTH: '#7142CF',
};

function parse(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1] ?? '0', 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
export function mix(a: string, b: string, t: number): string {
  const x = parse(a) ?? [128, 128, 128];
  const y = parse(b) ?? [128, 128, 128];
  return `#${hex2(x[0] + (y[0] - x[0]) * t)}${hex2(x[1] + (y[1] - x[1]) * t)}${hex2(x[2] + (y[2] - x[2]) * t)}`;
}
export function luminance(hex: string): number {
  const c = parse(hex);
  if (!c) return 0;
  return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
}
function hsl(h: number, s: number, l: number): string {
  const k = (m: number) => (m + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (m: number) => l - a * Math.max(-1, Math.min(k(m) - 3, Math.min(9 - k(m), 1)));
  return `#${hex2(f(0) * 255)}${hex2(f(8) * 255)}${hex2(f(4) * 255)}`;
}
/** Stable, pleasant colour for a ticker without a known one. */
export function tickerColor(symbol: string): string {
  const s = symbol.toUpperCase();
  const known = TICKER_COLORS[s];
  if (known) return known;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return hsl(((h >>> 0) % 360 + 360) % 360, 0.5, 0.47);
}

/** Monogram: the whole ticker up to 3 characters, else its first 2 (always 2 max below 26 px). */
export function monogram(symbol: string, size = 34): string {
  const s = [...symbol.replace(/[\s.\-_]/g, '').toUpperCase()];
  return s.slice(0, s.length <= 3 && size >= 26 ? 3 : 2).join('') || '?';
}

export interface El {
  t: string;
  a: Record<string, string | number>;
  c?: El[];
  text?: string;
}

const FONT = "'Geist Variable', Geist, Inter, system-ui, sans-serif";

export interface IconSpec {
  mark?: MarkDef | undefined;
  label?: string | undefined;
  color: string;
  ink?: string | undefined;
}

/** Disc base gradient stops [top, bottom]. */
export function discColors(spec: IconSpec): [string, string] {
  if (spec.mark?.base) return [spec.mark.base[0], spec.mark.base[1]];
  const c = spec.mark?.color ?? spec.color;
  return [mix(c, '#ffffff', 0.2), mix(c, '#000000', 0.3)];
}

function shapeEl(s: Shape, ink: string, accent: string, cut: string, shadow?: string): El {
  const color = shadow ?? (s.tone === 'accent' ? accent : s.tone === 'cut' ? cut : ink);
  const a: Record<string, string | number> = { d: s.d };
  if (s.w !== undefined) {
    a.fill = 'none';
    a.stroke = color;
    a['stroke-width'] = s.w;
    a['stroke-linecap'] = s.butt ? 'butt' : 'round';
    a['stroke-linejoin'] = 'round';
  } else {
    a.fill = color;
    if (s.evenodd) a['fill-rule'] = 'evenodd';
  }
  if (s.tone === 'soft' && !shadow) a.opacity = s.o ?? 0.7;
  if (s.tf) a.transform = s.tf;
  return { t: 'path', a };
}

/** The icon as an element tree in a 64 × 64 viewBox. */
export function iconTree(spec: IconSpec, uid: string): El {
  const [top, bottom] = discColors(spec);
  const mark = spec.mark;
  const ink = spec.ink ?? mark?.ink ?? (luminance(mix(top, bottom, 0.5)) > 0.74 ? '#101114' : '#FFFFFF');
  const darkInk = luminance(ink) < 0.4;
  const inkLow = mix(ink, bottom, darkInk ? 0.05 : 0.13);
  const shadow = mix(bottom, '#000000', 0.5);
  const id = (k: string) => `${uid}${k}`;
  const defs: El = {
    t: 'defs',
    a: {},
    c: [
      { t: 'linearGradient', a: { id: id('b'), x1: 0.15, y1: 0, x2: 0.85, y2: 1 }, c: [{ t: 'stop', a: { offset: 0, 'stop-color': top } }, { t: 'stop', a: { offset: 1, 'stop-color': bottom } }] },
      {
        t: 'radialGradient',
        a: { id: id('h'), cx: 0.3, cy: 0.16, r: 0.78 },
        c: [{ t: 'stop', a: { offset: 0, 'stop-color': '#ffffff', 'stop-opacity': 0.34 } }, { t: 'stop', a: { offset: 0.6, 'stop-color': '#ffffff', 'stop-opacity': 0 } }],
      },
      {
        t: 'linearGradient',
        a: { id: id('r'), x1: 0, y1: 0, x2: 0, y2: 1 },
        c: [
          { t: 'stop', a: { offset: 0, 'stop-color': '#ffffff', 'stop-opacity': 0.42 } },
          { t: 'stop', a: { offset: 0.5, 'stop-color': '#ffffff', 'stop-opacity': 0.04 } },
          { t: 'stop', a: { offset: 1, 'stop-color': '#000000', 'stop-opacity': 0.28 } },
        ],
      },
      { t: 'linearGradient', a: { id: id('i'), gradientUnits: 'userSpaceOnUse', x1: 0, y1: mark ? 3 : 16, x2: 0, y2: mark ? 21 : 48 }, c: [{ t: 'stop', a: { offset: 0, 'stop-color': ink } }, { t: 'stop', a: { offset: 1, 'stop-color': inkLow } }] },
    ],
  };
  const disc: El[] = [
    { t: 'circle', a: { cx: 32, cy: 32, r: 32, fill: `url(#${id('b')})` } },
    { t: 'circle', a: { cx: 32, cy: 32, r: 32, fill: `url(#${id('h')})` } },
    { t: 'circle', a: { cx: 32, cy: 32, r: 31.4, fill: 'none', stroke: `url(#${id('r')})`, 'stroke-width': 1.2 } },
  ];
  let content: El[];
  if (mark) {
    const s = mark.scale ?? 1.6;
    const o = 32 - 12 * s;
    const inkFill = `url(#${id('i')})`;
    const accent = mark.accent ?? ink;
    const cut = mix(bottom, top, 0.35);
    const tf = `translate(${n(o)} ${n(o)}) scale(${s})${mark.transform ? ` ${mark.transform}` : ''}`;
    content = [
      { t: 'g', a: { transform: tf }, c: [{ t: 'g', a: { transform: 'translate(0 0.75)', opacity: darkInk ? 0.18 : 0.5 }, c: mark.shapes.map((sh) => shapeEl(sh, ink, accent, cut, shadow)) }, ...mark.shapes.map((sh) => shapeEl(sh, inkFill, accent, cut))] },
    ];
  } else {
    const label = spec.label ?? '?';
    const len = [...label].length;
    const fs = len <= 1 ? 30 : len === 2 ? 24 : 18.5;
    const text = (fillColor: string, dy: number, extra: Record<string, string | number> = {}): El => ({
      t: 'text',
      a: { x: 32, y: n(32 + fs * 0.355 + dy), 'text-anchor': 'middle', 'font-family': FONT, 'font-weight': 650, 'font-size': fs, 'letter-spacing': len > 1 ? n(-fs * 0.03) : 0, fill: fillColor, ...extra },
      text: label,
    });
    content = [text(shadow, 1.2, { opacity: 0.5 }), text(`url(#${id('i')})`, 0)];
  }
  return { t: 'svg', a: { viewBox: '0 0 64 64' }, c: [defs, ...disc, ...content] };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Serialises a tree to SVG markup (standalone files). */
export function toSvgString(el: El, root = true): string {
  const attrs = { ...(root ? { xmlns: 'http://www.w3.org/2000/svg' } : {}), ...el.a };
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join('');
  const inner = (el.text !== undefined ? esc(el.text) : '') + (el.c ?? []).map((c) => toSvgString(c, false)).join('');
  return inner ? `<${el.t}${a}>${inner}</${el.t}>` : `<${el.t}${a}/>`;
}
