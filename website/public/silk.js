// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the blue silk behind every page, our own small WebGL shader on one fixed canvas.
// It leans towards the pointer and travels with the page, from the eased scroll value so a wheel
// notch never shows as a step. Tone follows the section in view ([data-tone], [data-hue]) slowly.
// Quality only changes between scrolls, rarely. It draws from the loop in motion.js. Without WebGL,
// with reduced motion or with Data Saver on, the CSS gradient under the canvas stays.
(function () {
  'use strict';

  var canvas = document.querySelector('canvas[data-silk]');
  var K = window.Kyro;
  if (!canvas || !K || !document.documentElement.classList.contains('js')) return;
  if (navigator.connection && navigator.connection.saveData) return;

  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 R;uniform float T;uniform vec2 M;uniform float S;uniform float A;uniform float H;uniform float V;',
    // Sine domain warp: each pass folds the cloth over itself.
    'float cloth(vec2 q){',
    '  for(int i=1;i<5;i++){float f=float(i);',
    '    q.x+=.62/f*sin(f*1.55*q.y+T*.42+f*1.3);',
    '    q.y+=.62/f*cos(f*1.55*q.x-T*.33+f*2.1);}',
    '  return sin(q.x*1.35+q.y*.8);',
    '}',
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/R;float a=R.x/R.y;',
    '  vec2 q=(uv-.5)*vec2(a,1.);',
    '  vec2 m=(M-.5)*vec2(a,1.);',
    '  vec2 d=q-m;float r2=dot(d,d);float near=exp(-r2*5.5);',
    '  float wave=sin(sqrt(r2)*24.-T*3.2)*exp(-r2*9.)*V;',  // moving the pointer rings the cloth
    '  q+=d*near*-.42+d*wave*.32;',
    '  q=mat2(.8,-.6,.6,.8)*q*2.1+vec2(.4,S*1.25);',
    '  float e=.012;',
    '  float h=cloth(q);',
    '  float hx=cloth(q+vec2(e,0.));float hy=cloth(q+vec2(0.,e));',
    '  vec3 n=normalize(vec3((h-hx)/e*.24,(h-hy)/e*.24,1.));',
    '  vec3 l=normalize(vec3(-.45+m.x*1.2,.55+m.y*1.2,.75));',
    '  float diff=max(dot(n,l),0.);',
    '  float spec=pow(max(dot(reflect(-l,n),vec3(0.,0.,1.)),0.),16.);',
    '  float v=pow(diff,2.6)*.62+spec*.72;',
    '  v*=mix(.62,1.,smoothstep(1.3,.2,length((uv-vec2(.6,.6))*vec2(1.2,1.))));',
    '  v+=near*(.13+.09*h)+near*V*.14;',
    // Black, deep blue, app blue, ice, then a white-hot crest.
    '  vec3 c=mix(vec3(0.),vec3(.006,.03,.095),smoothstep(.0,.14,v));',
    '  c=mix(c,vec3(.012,.15,.38),smoothstep(.1,.36,v));',
    '  c=mix(c,vec3(.14,.5,.9),smoothstep(.32,.6,v));',
    '  c=mix(c,vec3(.486,.769,1.),smoothstep(.56,.84,v));',
    '  c=mix(c,vec3(.87,.96,1.),smoothstep(.86,1.2,v));',
    '  c=mix(c*vec3(.62,.8,1.12),c,H);',
    // Interleaved gradient noise, one 8-bit step: keeps the long dark ramps free of banding.
    '  float g=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));',
    '  gl_FragColor=vec4(c*A+(g-.5)/170.,1.);',
    '}'
  ].join('\n');

  var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) return;

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  }
  var vs = shader(gl.VERTEX_SHADER, VERT);
  var fs = shader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;
  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var U = {};
  ['R', 'T', 'M', 'S', 'A', 'H', 'V'].forEach(function (n) {
    U[n] = gl.getUniformLocation(prog, n);
  });

  var coarse = window.matchMedia('(pointer: coarse)').matches;
  var scale = coarse ? 0.35 : (navigator.hardwareConcurrency || 8) <= 4 ? 0.4 : 0.6;
  var bufW = 0, bufH = 0;
  function resize(force) {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    // A phone's address bar changes the height while scrolling: only ever grow for that.
    if (!force && w === bufW && h <= bufH) return;
    bufW = w;
    bufH = h;
    canvas.width = Math.max(2, Math.round(w * scale));
    canvas.height = Math.max(2, Math.round(h * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // Section tones, measured once and on resize.
  var zones = [];
  function measure() {
    var y = window.scrollY;
    zones = Array.prototype.map.call(document.querySelectorAll('[data-tone]'), function (el) {
      var b = el.getBoundingClientRect();
      return { top: b.top + y, bottom: b.bottom + y, tone: +el.getAttribute('data-tone'), hue: +(el.getAttribute('data-hue') || 0.5) };
    });
  }
  function onResize() {
    resize(false);
    measure();
  }
  K.resize(onResize);
  window.addEventListener('load', measure);
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.body);
  onResize();

  var tone = 1.1, hue = 1, zoneT = 1.1, zoneH = 1;
  function pickZone(y) {
    var c = y + K.vh * 0.5;
    zoneT = 0.6;
    zoneH = 0.4;
    for (var i = 0; i < zones.length; i++) {
      if (c >= zones[i].top && c < zones[i].bottom) {
        zoneT = zones[i].tone;
        zoneH = zones[i].hue;
      }
    }
  }

  var mx = 0.68, my = 0.62, tx = mx, ty = my, speed = 0, touched = -1e9;
  function point(e, bump) {
    var nx = e.clientX / window.innerWidth;
    var ny = 1 - e.clientY / K.vh;
    speed = Math.min(1, speed + bump + Math.hypot(nx - tx, ny - ty) * 5);
    tx = nx;
    ty = ny;
    touched = performance.now();
  }
  window.addEventListener(
    'pointermove',
    function (e) {
      point(e, 0);
    },
    { passive: true }
  );
  // A tap rings the cloth where the finger landed.
  window.addEventListener(
    'pointerdown',
    function (e) {
      if (e.pointerType === 'touch') point(e, 0.7);
    },
    { passive: true }
  );

  var travel = K.y, t0 = performance.now(), dead = false, started = false;
  // Quality: judged over 4 quiet seconds, at most once every 20 s, never during a scroll.
  var sum = 0, n = 0, nextCheck = 0;
  function quality(now) {
    if (Math.abs(K.v) > 40 || K.raw > 200) return;
    sum += K.raw;
    n++;
    if (now < nextCheck || n < 120) return;
    var avg = sum / n;
    sum = n = 0;
    nextCheck = now + 4000;
    if (avg < 30) return;
    nextCheck = now + 20000;
    if (scale > 0.3) {
      scale *= 0.75;
      resize(true); // the frame below redraws at once, so nothing blinks
    } else if (avg > 45) {
      canvas.classList.remove('on');
      dead = true;
    }
  }

  K.frame(function (y, now, dt) {
    if (!started || dead) return;
    quality(now);
    pickZone(y);
    tone = K.damp(tone, zoneT, 1.1, dt);
    hue = K.damp(hue, zoneH, 1.1, dt);
    // The cloth moves with the page, a touch behind it.
    travel = K.damp(travel, y, 0.16, dt);
    // No pointer on a phone: the light wanders on its own, and follows the swipe a little.
    if (coarse && now - touched > 2500) {
      var w = (now - t0) / 1000;
      tx = 0.5 + 0.32 * Math.sin(w * 0.31);
      ty = 0.55 + 0.3 * Math.cos(w * 0.23) + Math.max(-0.2, Math.min(0.2, K.v / 9000));
    }
    mx = K.damp(mx, tx, 0.14, dt);
    my = K.damp(my, ty, 0.14, dt);
    speed *= Math.exp(-dt / 0.45);
    gl.uniform2f(U.R, canvas.width, canvas.height);
    gl.uniform1f(U.T, (now - t0) / 1000);
    gl.uniform2f(U.M, mx, my);
    gl.uniform1f(U.S, travel / K.vh);
    gl.uniform1f(U.A, tone);
    gl.uniform1f(U.H, hue);
    gl.uniform1f(U.V, speed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    K.p && (K.p.silk = (travel / K.vh) * 1.25);
  });

  // After the page is on screen: the hero never waits for the shader.
  function begin() {
    started = true;
    requestAnimationFrame(function () {
      canvas.classList.add('on');
    });
  }
  if (document.readyState === 'complete') begin();
  else window.addEventListener('load', begin);
})();
