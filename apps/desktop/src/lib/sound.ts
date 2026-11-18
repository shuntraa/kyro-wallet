// SPDX-License-Identifier: GPL-3.0-or-later
// The "funds received" sound, synthesized with Web Audio: no sound file, nothing fetched.
// A cash-register "cha-ching" of our own: a short rattle of coins and the drawer's thump, then a
// struck metal bell (inharmonic partials, each a slightly detuned pair that shimmers), in a small
// room made from a generated impulse response.

/** Struck-bell partials: ratio to the strike note, level, decay (s). Ratios of a real small bell. */
const BELL: ReadonlyArray<readonly [number, number, number]> = [
  [0.5, 0.18, 1.1],
  [1, 1, 1.5],
  [1.19, 0.42, 0.9],
  [1.5, 0.36, 0.8],
  [2, 0.55, 0.75],
  [2.51, 0.22, 0.45],
  [3.01, 0.16, 0.35],
  [4.17, 0.08, 0.22],
];

/** Deterministic noise (the same sound every time). */
function noise(n: number, seed: number): Float32Array {
  const d = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    d[i] = (s / 2147483647) * 2 - 1;
  }
  return d;
}

function buffer(ctx: BaseAudioContext, data: Float32Array[]): AudioBuffer {
  const b = ctx.createBuffer(data.length, data[0]?.length ?? 1, ctx.sampleRate);
  data.forEach((d, i) => b.getChannelData(i).set(d));
  return b;
}

function bell(ctx: BaseAudioContext, out: AudioNode, f: number, at: number, level: number): void {
  for (const [ratio, a, decay] of BELL) {
    for (const [detune, pan] of [
      [-1.6, -0.35],
      [1.6, 0.35],
    ] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f * ratio + detune;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(a * level * 0.5, at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      o.connect(g).connect(p).connect(out);
      o.start(at);
      o.stop(at + decay + 0.05);
    }
  }
  // The strike itself: a very short bright tick.
  const n = Math.floor(ctx.sampleRate * 0.012);
  const src = ctx.createBufferSource();
  src.buffer = buffer(ctx, [noise(n, 11)]);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(level * 0.5, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.012);
  src.connect(hp).connect(g).connect(out);
  src.start(at);
}

/** One coin hitting others: a metallic click (noise through a narrow resonance). */
function coin(ctx: BaseAudioContext, out: AudioNode, at: number, freq: number, level: number, pan: number, seed: number): void {
  const n = Math.floor(ctx.sampleRate * 0.09);
  const src = ctx.createBufferSource();
  src.buffer = buffer(ctx, [noise(n, seed)]);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 18;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(level, at + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  src.connect(bp).connect(g).connect(p).connect(out);
  src.start(at);
}

function thump(ctx: BaseAudioContext, out: AudioNode, at: number, level: number): void {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(110, at);
  o.frequency.exponentialRampToValueAtTime(55, at + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(level, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + 0.2);
}

/** A small, bright room: stereo noise with an exponential tail. */
function room(ctx: BaseAudioContext): ConvolverNode {
  const n = Math.floor(ctx.sampleRate * 0.9);
  const ch = [noise(n, 3), noise(n, 5)].map((d) => {
    for (let i = 0; i < n; i++) d[i] = (d[i] ?? 0) * Math.exp((-i / ctx.sampleRate) * 6.5);
    return d;
  });
  const c = ctx.createConvolver();
  c.buffer = buffer(ctx, ch);
  return c;
}

/** Schedules the sound on `ctx` from time `at` (about 1.5 s long). */
export function renderReceived(ctx: BaseAudioContext, dest: AudioNode, at: number): void {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 4;
  comp.connect(dest);
  const dry = ctx.createGain();
  dry.gain.value = 0.85;
  dry.connect(comp);
  const wet = ctx.createGain();
  wet.gain.value = 0.22;
  wet.connect(comp);
  const bus = ctx.createGain();
  bus.gain.value = 0.62;
  const verb = room(ctx);
  bus.connect(dry);
  bus.connect(verb).connect(wet);
  // "Cha": the drawer and a quick rattle of coins.
  thump(ctx, bus, at, 0.5);
  const hits: ReadonlyArray<readonly [number, number, number]> = [
    [0.0, 5200, 0.5],
    [0.022, 6900, 0.38],
    [0.041, 4400, 0.42],
    [0.058, 7800, 0.3],
    [0.079, 5900, 0.33],
    [0.097, 4900, 0.24],
    [0.118, 7100, 0.18],
  ];
  hits.forEach(([dt, f, l], i) => coin(ctx, bus, at + dt, f, l, i % 2 ? 0.3 : -0.3, 101 + i * 7));
  // "Ching": the bell.
  bell(ctx, bus, 1568, at + 0.13, 0.42);
}

let live: AudioContext | null = null;

// The app's webview may start audio "suspended" until the user interacts: the first click or key
// in Kyro opens the audio output, so the sound can play later when funds arrive in the background.
function prime(): void {
  try {
    live ??= new AudioContext();
    void live.resume();
  } catch {
    /* no audio output */
  }
}
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, prime, { once: true, capture: true });
}

/** Plays the sound now. Silent (no error) where audio is unavailable or blocked. */
export function playReceived(): void {
  try {
    live ??= new AudioContext();
    const ctx = live;
    void ctx.resume().then(() => renderReceived(ctx, ctx.destination, ctx.currentTime + 0.02));
  } catch {
    /* no audio output: the notification still says it */
  }
}
