// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the blue silk, our own small WebGL shader on one fixed canvas. It only ever knows
// the time: the scrim that dims it behind the content is plain page background, so scrolling stays
// with the compositor and nothing here reads the scroll position or the layout. It draws a small
// buffer that CSS scales up, at 30 to 40 fps, and stops with the tab. Without WebGL, with reduced
// motion, with Data Saver on or on a GPU that cannot keep up, the still image under it stays.
(function () {
  'use strict';

  var canvas = document.querySelector('canvas[data-silk]');
  var K = window.Kyro;
  if (!canvas || !K || !K.motion) return;
  if (navigator.connection && navigator.connection.saveData) return;

  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 R;uniform float T;uniform vec2 L;',
    // Sine domain warp, two passes: wide folds only, nothing fine enough to shimmer.
    'float cloth(vec2 q){',
    '  q.x+=.62*sin(1.55*q.y+T*.42+1.3);',
    '  q.y+=.62*cos(1.55*q.x-T*.33+2.1);',
    '  q.x+=.31*sin(3.1*q.y-T*.27+3.9);',
    '  q.y+=.31*cos(3.1*q.x+T*.23+4.2);',
    '  return sin(q.x*1.35+q.y*.8);',
    '}',
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/R;float a=R.x/R.y;',
    '  vec2 q=(uv-.5)*vec2(a,1.);',
    '  q=mat2(.8,-.6,.6,.8)*q*2.1+vec2(.4,.2);',
    // Lit along one direction: two samples of the cloth give the slope facing the light.
    '  float h=cloth(q);float s=(cloth(q+L*.05)-h)*8.;',
    '  float v=.4+.14*h+.52*s/(1.+abs(s));',
    '  v*=mix(.58,1.,smoothstep(1.25,.15,length((uv-vec2(.64,.62))*vec2(1.15,1.))));',
    // Near-black, deep blue, then Kyro blue as the brightest it ever gets: no hot spot behind text.
    '  vec3 c=mix(vec3(.012,.03,.075),vec3(.016,.11,.29),smoothstep(.08,.5,v));',
    '  c=mix(c,vec3(.075,.33,.68),smoothstep(.42,.95,v));',
    // Interleaved gradient noise, one 8-bit step and fixed in place: no banding, no shimmer.
    '  float g=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));',
    '  gl_FragColor=vec4(c+(g-.5)/128.,1.);',
    '}'
  ].join('\n');

  // A software renderer would draw this on the CPU, next to the page: the caveat flag refuses it.
  var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true });
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
  var uR = gl.getUniformLocation(prog, 'R'), uT = gl.getUniformLocation(prog, 'T'), uL = gl.getUniformLocation(prog, 'L');

  // Sized in CSS pixels, so the device pixel ratio never adds work. A huge screen stays under the cap.
  var scale = K.coarse ? 0.35 : 0.5;
  var MAX_PIXELS = 600000;
  function resize() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var s = Math.min(scale, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
    canvas.width = Math.max(2, Math.round(w * s));
    canvas.height = Math.max(2, Math.round(h * s));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uR, canvas.width, canvas.height);
  }
  K.resize(resize);
  resize();

  // The pointer only leans the light a few degrees, over seconds.
  var mx = 0, my = 0, tx = 0, ty = 0;
  if (K.fine) {
    window.addEventListener(
      'pointermove',
      function (e) {
        tx = e.clientX / window.innerWidth - 0.5;
        ty = 0.5 - e.clientY / window.innerHeight;
      },
      { passive: true }
    );
  }

  var live = false;
  function stop() {
    live = false;
    canvas.classList.remove('on');
  }
  canvas.addEventListener('webglcontextlost', stop);

  // Quality: rAF intervals over a few seconds. A slow device first gets a smaller buffer, then the image.
  var sum = 0, n = 0, wait = 3, last = 0;
  function quality(now, raw) {
    if (raw > 200) return;
    if (now < wait) return;
    sum += raw;
    if (++n < 150) return;
    var avg = sum / n;
    sum = n = 0;
    if (avg < 24) return;
    wait = now + 2000;
    if (scale > 0.2) {
      scale *= 0.7;
      resize();
    } else {
      stop();
    }
  }

  // Seconds of cloth. Added up from clamped steps, so a stall slows it for a moment and never jumps.
  var T = 18, lastDraw = 0;
  K.frame(function (now, dt) {
    if (!live) return;
    if (last) quality(now, now - last);
    last = now;
    T += dt * 0.16;
    mx = K.damp(mx, tx, 3, dt);
    my = K.damp(my, ty, 3, dt);
    // rAF stops in a hidden tab, and this with it. 26 ms: 30 fps at 60 Hz, 36 fps at 144 Hz.
    if (now - lastDraw < 26) return;
    lastDraw = now;
    gl.uniform1f(uT, T);
    gl.uniform2f(uL, -0.62 + mx * 0.14, 0.78 + my * 0.14);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });

  // After the page is on screen: the hero never waits for the shader.
  function begin() {
    live = true;
    wait = performance.now() + 3000;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (live) canvas.classList.add('on');
      });
    });
  }
  if (document.readyState === 'complete') begin();
  else window.addEventListener('load', begin);
})();
