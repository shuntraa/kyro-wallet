// SPDX-License-Identifier: GPL-3.0-or-later
// Bakes the two still images of the Kyro blue light: the first frame of the live satin, which stands in
// for it (no WebGL, reduced motion, Data Saver), and the strip that lights the footer wordmark. Run by hand when the look changes (needs ffmpeg):
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

const unit = (a) => {
  const l = Math.hypot(...a);
  return a.map((x) => x / l);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The height of the satin, as in silk.js. */
function fold(x, y, T) {
  for (let f = 1; f <= 3; f++) {
    x += (0.62 / f) * Math.sin(f * 1.55 * y + T * 0.42 + f * 1.3);
    y += (0.62 / f) * Math.cos(f * 1.55 * x - T * 0.33 + f * 2.1);
  }
  return Math.sin(x * 1.4 + y * 0.8) + 0.04 * Math.sin(x * 4.7 - y * 3.1);
}

/** The frame of silk.js at time T. One knee all over: a phone crops this image to any part of it. */
function satin({ w, h, T }) {
  const buf = Buffer.alloc(w * h * 3);
  const key = unit([-0.62, 0.72, 0.6]), half = unit([key[0], key[1], key[2] + 1]), side = [0.56, -0.34, 0.76];
  const stops = [[0.008, 0.016, 0.045], [0.012, 0.075, 0.235], [0.085, 0.29, 0.72], [0.49, 0.77, 1]];
  const e = 0.012, knee = 0.42;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5) / w, t = 1 - (py + 0.5) / h;
      const x = (u - 0.5) * (w / h) * 3.8 + 0.4, y = (t - 0.5) * 3.8 + 0.2;
      const c0 = fold(x, y, T), gx = (fold(x + e, y, T) - c0) / e, gy = (fold(x, y + e, T) - c0) / e;
      const n = unit([-gx * 0.2, -gy * 0.2, 1]);
      const d = Math.max(dot(n, key), 0), nm = Math.max(dot(n, half), 0), th = dot(unit([-gy, gx, 0.5]), half);
      let v = (0.03 + 0.46 * d * d + 0.05 * Math.max(dot(n, side), 0)) * (0.84 + 0.16 * c0) + 0.08 * nm ** 16 + 0.03 * Math.max(1 - th * th, 0) ** 18 + 0.13 * nm ** 60;
      v *= mix(1, 0.5, step(0.3, 0.95, Math.hypot(u - 0.56, (t - 0.56) * 1.1)));
      const over = Math.max(v - knee, 0);
      v = Math.min(v, knee) + over / (1 + over * 9);
      let c = stops[0];
      for (const [i, a, b] of [[1, 0.02, 0.28], [2, 0.22, 0.56], [3, 0.52, 0.84]]) c = c.map((k, j) => mix(k, stops[i][j], step(a, b, v)));
      for (let j = 0; j < 3; j++) buf[(py * w + px) * 3 + j] = Math.min(255, c[j] * 255);
    }
  }
  return buf;
}

function bake(name, opts, filter, quality, draw = render) {
  const raw = join(tmpdir(), `kyro-${name}.rgb`);
  writeFileSync(raw, draw(opts));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${opts.w}x${opts.h}`, '-i', raw, '-vf', filter, '-c:v', 'libwebp', '-quality', String(quality), join(OUT, `${name}.webp`)]);
  rmSync(raw);
}

// Hero: the live shader's first frame (T = 18), so the canvas fades in over the same folds.
bake('light-hero', { w: 1440, h: 900, T: 18 }, 'gblur=sigma=2,noise=alls=2:allf=t', 80, satin);
// Footer: the sharper silk, seen only through the letters: the bottom third of a screen-sized cloth.
bake('light-foot', { w: 1848, h: 356, T: 14, zoom: 2.1, gain: 1, spec: 0.72, ramp: 0.55, aspect: 1.6, top: 0.31, bottom: 0 }, 'null', 80);
