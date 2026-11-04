// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the blue silk, our own small WebGL shader on one fixed canvas. Rich in the hero,
// a faint slow glow behind the rest, and back up behind the footer wordmark. The drift comes from a
// heavily eased scroll value, so no input ever shows as a step. It draws at about 30 fps from the
// loop in motion.js. Without WebGL, with reduced motion or with Data Saver on, the CSS gradient stays.
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
    'uniform vec2 R;uniform float T;uniform vec2 M;uniform float S;uniform float A;',
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
    '  q+=d*near*-.2;',
    '  q=mat2(.8,-.6,.6,.8)*q*2.1+vec2(.4,S*1.25);',
    '  float e=.012;',
    '  float h=cloth(q);',
    '  float hx=cloth(q+vec2(e,0.));float hy=cloth(q+vec2(0.,e));',
    '  vec3 n=normalize(vec3((h-hx)/e*.24,(h-hy)/e*.24,1.));',
    '  vec3 l=normalize(vec3(-.45+m.x*.7,.55+m.y*.7,.75));',
    '  float diff=max(dot(n,l),0.);',
    '  float spec=pow(max(dot(reflect(-l,n),vec3(0.,0.,1.)),0.),16.);',
    '  float v=pow(diff,2.6)*.62+spec*.72;',
    '  v*=mix(.62,1.,smoothstep(1.3,.2,length((uv-vec2(.6,.6))*vec2(1.2,1.))));',
    '  v+=near*(.08+.05*h);',
    // Black, deep blue, Kyro blue, then ice as the brightest it ever gets: no white behind text.
    '  vec3 c=mix(vec3(0.),vec3(.006,.03,.095),smoothstep(.0,.14,v));',
    '  c=mix(c,vec3(.012,.15,.38),smoothstep(.1,.36,v));',
    '  c=mix(c,vec3(.12,.46,.86),smoothstep(.32,.62,v));',
    '  c=mix(c,vec3(.42,.72,1.),smoothstep(.6,1.,v)*.8);',
    // Interleaved gradient noise, one 8-bit step: keeps the long dark ramps free of banding.
    '  float g=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));',
    '  gl_FragColor=vec4(c*A+vec3(.0157,.0235,.039)+(g-.5)/170.,1.);',
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
  ['R', 'T', 'M', 'S', 'A'].forEach(function (n) {
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

  // Full in the hero, quiet behind the content, up again where the wordmark cuts through the footer.
  var word = document.querySelector('.foot-word');
  var HERO = document.querySelector('.hero') ? 1 : 0.72, REST = 0.2, FOOT = 0.8;
  var wordTop = 1e9, wordH = 1;
  function measure() {
    if (!word) return;
    var b = word.getBoundingClientRect();
    wordTop = b.top + window.scrollY;
    wordH = b.height || 1;
  }
  function onResize() {
    resize(false);
    measure();
  }
  K.resize(onResize);
  window.addEventListener('load', measure);
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.body);
  onResize();

  function ease(t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }
  function toneAt(y) {
    var hero = REST + (HERO - REST) * (1 - ease(y / (K.vh * 0.62)));
    return hero + (FOOT - REST) * ease((y + K.vh - wordTop) / wordH);
  }

  var mx = 0.68, my = 0.62, tx = mx, ty = my;
  window.addEventListener(
    'pointermove',
    function (e) {
      tx = e.clientX / window.innerWidth;
      ty = 1 - e.clientY / K.vh;
    },
    { passive: true }
  );

  var t0 = performance.now(), lastDraw = 0, dead = false, started = false;
  // Quality: judged over a few seconds, at most once every 20 s.
  var sum = 0, n = 0, nextCheck = 0;
  function quality(now) {
    if (K.raw > 200) return;
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
    // No pointer on a phone: the light wanders on its own.
    if (coarse) {
      var w = (now - t0) / 1000;
      tx = 0.5 + 0.32 * Math.sin(w * 0.21);
      ty = 0.55 + 0.3 * Math.cos(w * 0.16);
    }
    mx = K.damp(mx, tx, 0.6, dt);
    my = K.damp(my, ty, 0.6, dt);
    if (now - lastDraw < 28) return;
    lastDraw = now;
    gl.uniform2f(U.R, canvas.width, canvas.height);
    gl.uniform1f(U.T, ((now - t0) / 1000) * 0.6);
    gl.uniform2f(U.M, mx, my);
    gl.uniform1f(U.S, (y / K.vh) * 0.3);
    gl.uniform1f(U.A, toneAt(y));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
