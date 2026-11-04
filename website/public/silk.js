// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the blue silk behind every page, our own small WebGL shader on one fixed canvas.
// It leans towards the pointer, changes tone with the section in view ([data-tone], [data-hue]),
// drops its resolution on slow machines and stops when hidden. Without WebGL, with reduced motion
// or with Data Saver on, the CSS gradient under the canvas stays.
(function () {
  'use strict';

  var canvas = document.querySelector('canvas[data-silk]');
  if (!canvas || !document.documentElement.classList.contains('js')) return;
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
    '  gl_FragColor=vec4(c*A,1.);',
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
  function resize() {
    var w = Math.max(2, Math.round(canvas.clientWidth * scale));
    var h = Math.max(2, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
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
    resize();
    measure();
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('load', measure);
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.body);
  onResize();

  var tone = 1.1, hue = 1;
  function targets(now) {
    var c = window.scrollY + window.innerHeight * 0.5;
    var t = 0.6, h = 0.4;
    for (var i = 0; i < zones.length; i++) {
      if (c >= zones[i].top && c < zones[i].bottom) {
        t = zones[i].tone;
        h = zones[i].hue;
      }
    }
    tone += (t - tone) * 0.045;
    hue += (h - hue) * 0.045;
  }

  var mx = 0.68, my = 0.62, tx = mx, ty = my, speed = 0;
  window.addEventListener(
    'pointermove',
    function (e) {
      var nx = e.clientX / window.innerWidth;
      var ny = 1 - e.clientY / window.innerHeight;
      speed = Math.min(1, speed + Math.hypot(nx - tx, ny - ty) * 5);
      tx = nx;
      ty = ny;
    },
    { passive: true }
  );

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) start();
  });

  var running = false, last = 0, slow = 0, skip = false, t0 = performance.now(), dead = false;
  function frame(now) {
    if (document.hidden || dead) {
      running = false;
      return;
    }
    requestAnimationFrame(frame);
    if (coarse && (skip = !skip)) return; // phones: 30 fps is plenty for slow cloth
    var dt = now - last;
    last = now;
    // A long run of slow frames: fewer pixels first, then keep the gradient and stop.
    slow = dt > (coarse ? 60 : 34) ? slow + 1 : Math.max(0, slow - 1);
    if (slow > 45) {
      slow = 0;
      if (scale > 0.2) {
        scale *= 0.7;
        resize();
      } else {
        canvas.classList.remove('on');
        dead = true;
        return;
      }
    }
    targets(now);
    mx += (tx - mx) * 0.07;
    my += (ty - my) * 0.07;
    speed *= 0.965;
    gl.uniform2f(U.R, canvas.width, canvas.height);
    gl.uniform1f(U.T, (now - t0) / 1000);
    gl.uniform2f(U.M, mx, my);
    gl.uniform1f(U.S, (window.scrollY || 0) / (window.innerHeight || 800));
    gl.uniform1f(U.A, tone);
    gl.uniform1f(U.H, hue);
    gl.uniform1f(U.V, speed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }
  function begin() {
    start();
    requestAnimationFrame(function () {
      canvas.classList.add('on');
    });
  }
  // After the page is on screen: the hero never waits for the shader.
  if (document.readyState === 'complete') begin();
  else window.addEventListener('load', begin);
})();
