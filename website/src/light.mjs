// SPDX-License-Identifier: GPL-3.0-or-later
// Bakes the two still images of the Kyro blue light: the soft one that stands in for the live silk
// (no WebGL, reduced motion, Data Saver, weak GPUs) and the strip that lights the footer wordmark. Run by hand when the look changes (needs ffmpeg):
//   node website/src/light.mjs
import { writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'img');
const mix = (a, b, t) => a + (b - a) * t;
const step = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Sine domain warp: each pass folds the cloth over itself. */
function cloth(x, y, T) {
  for (let i = 1; i < 5; i++) {
    x += (0.62 / i) * Math.sin(i * 1.55 * y + T * 0.42 + i * 1.3);
    y += (0.62 / i) * Math.cos(i * 1.55 * x - T * 0.33 + i * 2.1);
  }
  return Math.sin(x * 1.35 + y * 0.8);
}

function render({ w, h, T, zoom, gain, spec, ramp, aspect, top = 1, bottom = 0 }) {
  const buf = Buffer.alloc(w * h * 3);
  const a = aspect || w / h, e = 0.012;
  const L = [-0.45, 0.55, 0.75], ll = Math.hypot(...L);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5) / w, v = mix(top, bottom, (py + 0.5) / h);
      const qx0 = (u - 0.5) * a, qy0 = v - 0.5;
      const qx = (0.8 * qx0 - 0.6 * qy0) * zoom + 0.4, qy = (0.6 * qx0 + 0.8 * qy0) * zoom;
      const c0 = cloth(qx, qy, T);
      const nx = ((c0 - cloth(qx + e, qy, T)) / e) * 0.24, ny = ((c0 - cloth(qx, qy + e, T)) / e) * 0.24;
      const nl = Math.hypot(nx, ny, 1);
      const d = Math.max(0, (nx * L[0] + ny * L[1] + L[2]) / (nl * ll));
      const rz = (2 * d * (1 / nl)) - L[2] / ll;
      const s = Math.pow(Math.max(0, rz), 16);
      const val = (Math.pow(d, 2.6) * 0.62 + s * spec) * gain;
      let r = 0, g = 0, b = 0;
      const blend = (c, t) => {
        r = mix(r, c[0], t);
        g = mix(g, c[1], t);
        b = mix(b, c[2], t);
      };
      blend([0.006, 0.03, 0.095], step(0, 0.14, val));
      blend([0.012, 0.15, 0.38], step(0.1, 0.36, val));
      blend([0.12, 0.46, 0.86], step(0.32, 0.62, val));
      const i = (py * w + px) * 3;
      buf[i] = Math.min(255, (r * ramp + 0.0157) * 255);
      buf[i + 1] = Math.min(255, (g * ramp + 0.0235) * 255);
      buf[i + 2] = Math.min(255, (b * ramp + 0.039) * 255);
    }
  }
  return buf;
}

function bake(name, opts, filter, quality) {
  const raw = join(tmpdir(), `kyro-${name}.rgb`);
  writeFileSync(raw, render(opts));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${opts.w}x${opts.h}`, '-i', raw, '-vf', filter, '-c:v', 'libwebp', '-quality', String(quality), join(OUT, `${name}.webp`)]);
  rmSync(raw);
}

// Hero: wide soft folds, blurred until only the light is left, and never brighter than a mid blue.
bake('light-hero', { w: 1440, h: 900, T: 7.5, zoom: 1.5, gain: 0.9, spec: 0.2, ramp: 0.62 }, 'gblur=sigma=30,noise=alls=2:allf=t', 88);
// Footer: the sharper silk, seen only through the letters: the bottom third of a screen-sized cloth.
bake('light-foot', { w: 1848, h: 356, T: 14, zoom: 2.1, gain: 1, spec: 0.72, ramp: 0.55, aspect: 1.6, top: 0.31, bottom: 0 }, 'null', 80);
