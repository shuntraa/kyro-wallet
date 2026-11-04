// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the blue satin, our own small WebGL shader on one fixed canvas: a folded height
// field, lit. The scrim that dims it behind the content is plain page background, so scrolling stays with
// the compositor. The cloth leans towards the pointer and drifts with the page, from eased copies of both
// that only ever reach it as uniforms: scrollY is read once per frame, never in a scroll handler. It
// draws every frame the display shows, at 60 or 240 Hz alike, into a small buffer that CSS scales up,
// and stops with the tab. Frames that miss vsync shrink the buffer, never the frame rate.
// Without WebGL, with reduced motion or with Data Saver on, the still image stays.
(function () {
  'use strict';

  var canvas = document.querySelector('canvas[data-silk]');
  var K = window.Kyro;
  if (!canvas || !K || !K.motion) return;
  if (navigator.connection && navigator.connection.saveData) return;

  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  // Phones fold the cloth one pass less: only fine creases go.
  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    '#define PASSES ' + (K.coarse ? 2 : 3),
    'uniform vec2 R;uniform float T;uniform vec2 L;uniform float W;uniform vec3 M;uniform float S;',
    // The height of the cloth: a sine domain warp folds one large wave over itself.
    'float cloth(vec2 q){',
    '  for(int i=1;i<=PASSES;i++){',
    '    float f=float(i);',
    '    q.x+=.62/f*sin(f*1.55*q.y+T*.42+f*1.3);',
    '    q.y+=.62/f*cos(f*1.55*q.x-T*.33+f*2.1);',
    '  }',
    '  return sin(q.x*1.4+q.y*.8)+.04*sin(q.x*4.7-q.y*3.1);',
    '}',
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/R;',
    '  vec2 a=vec2(R.x/R.y,1.);',
    // Around the pointer (M.xy, faded in by M.z) the folds are drawn in, and lit from where it is.
    '  vec2 o=(uv-M.xy)*a;',
    '  float near=M.z*exp(-dot(o,o)*5.5);',
    '  vec2 q=((uv-.5)*a+o*near*.2)*mix(4.4,3.8,W)+vec2(.4,.2-S);',
    // Forward differences: three heights give the slope, and the slope gives the normal.
    '  float h=cloth(q);',
    '  vec2 g=(vec2(cloth(q+vec2(.012,0.)),cloth(q+vec2(0.,.012)))-h)/.012;',
    '  vec3 n=normalize(vec3(-g*.2,1.));',
    // A key light from the top left, a soft fill from the other side, a satin lobe around the tight one.
    '  vec3 l=normalize(vec3(L-o*near*1.1,.6));',
    '  vec3 m=normalize(l+vec3(0.,0.,1.));',
    '  float d=max(dot(n,l),0.);',
    '  float fill=max(dot(n,vec3(.56,-.34,.76)),0.);',
    '  float nm=max(dot(n,m),0.);',
    // Strand sheen: threads run along the fold, so they catch the light across it, without any texture.
    '  float th=dot(normalize(vec3(-g.y,g.x,.5)),m);',
    '  float sheen=pow(max(1.-th*th,0.),18.);',
    '  float v=(.03+.46*d*d+.05*fill)*(.84+.16*h)+.08*pow(nm,16.)+.03*sheen+.13*pow(nm,60.);',
    '  vec2 e=(uv-vec2(.56,.56))*vec2(1.,1.1);',
    '  v*=mix(1.,.5,smoothstep(.3,.95,length(e)));',
    '  v+=near*(.05+.03*h);',
    // Behind the text the peaks flatten out into blue: left of the hero on a wide screen, all of a phone.
    '  float open=W*smoothstep(.24,.8,uv.x);',
    '  float knee=mix(.34,.66,open);',
    '  float over=max(v-knee,0.);',
    '  v=min(v,knee)+over/(1.+over*mix(9.,3.,open));',
    // Near-black navy, deep blue, Kyro blue, ice, and a soft near-white for the very peaks only.
    '  vec3 c=mix(vec3(.008,.016,.045),vec3(.012,.075,.235),smoothstep(.02,.28,v));',
    '  c=mix(c,vec3(.085,.29,.72),smoothstep(.22,.56,v));',
    '  c=mix(c,vec3(.49,.77,1.),smoothstep(.52,.84,v));',
    '  c=mix(c,vec3(.88,.95,1.),smoothstep(.84,1.1,v));',
    // Interleaved gradient noise, one 8-bit step and fixed in place: no banding, no shimmer.
    '  float z=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));',
    '  gl_FragColor=vec4(c+(z-.5)/128.,1.);',
    '}'
  ].join('\n');

  // A software renderer would draw this on the CPU, next to the page: the caveat flag refuses it.
  var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true });
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
  var uR = gl.getUniformLocation(prog, 'R'), uT = gl.getUniformLocation(prog, 'T'), uL = gl.getUniformLocation(prog, 'L'), uW = gl.getUniformLocation(prog, 'W'), uM = gl.getUniformLocation(prog, 'M'), uS = gl.getUniformLocation(prog, 'S');

  // Sized in CSS pixels, so the device pixel ratio never adds work. A huge screen stays under the cap.
  var scale = K.coarse ? 0.35 : 0.5;
  var MAX_PIXELS = 600000;
  var cw = 1, ch = 1;
  function resize() {
    var w = (cw = canvas.clientWidth), h = (ch = canvas.clientHeight);
    var s = Math.min(scale, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
    canvas.width = Math.max(2, Math.round(w * s));
    canvas.height = Math.max(2, Math.round(h * s));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uR, canvas.width, canvas.height);
    gl.uniform1f(uW, w / h > 1.15 ? 1 : 0);
  }
  K.resize(resize);
  resize();

  // The handlers only store. A finger never leans the cloth: it scrolls, and that is what the silk follows.
  var tx = 0, ty = 0, inside = 0;
  if (K.fine) {
    window.addEventListener(
      'pointermove',
      function (e) {
        if (e.pointerType === 'touch') return;
        tx = e.clientX;
        ty = e.clientY;
        inside = 1;
      },
      { passive: true }
    );
    document.documentElement.addEventListener('pointerleave', function () {
      inside = 0;
    });
  }

  var live = false;
  function stop() {
    live = false;
    canvas.classList.remove('on');
  }
  canvas.addEventListener('webglcontextlost', stop);

  // Quality: the shortest steady interval is the display's refresh. When a window of frames keeps missing
  // it, the buffer shrinks a little.
  var WINDOW = 120, ticks = new Float32Array(WINDOW);
  var n = 0, wait = 3000, last = 0, refresh = 1000, bad = 0;
  function quality(now, raw) {
    if (raw > 200 || now < wait) return;
    ticks[n++] = raw;
    if (n < WINDOW) return;
    n = 0;
    ticks.sort();
    refresh = Math.min(ticks[WINDOW >> 2], refresh * 1.02);
    var missed = WINDOW - 1;
    while (missed >= 0 && ticks[missed] > refresh * 1.5) missed--;
    bad = WINDOW - 1 - missed > WINDOW / 10 ? bad + 1 : 0;
    if (bad < 2) return;
    bad = 0;
    wait = now + 1000;
    if (scale > 0.2) {
      scale *= 0.9;
      resize();
    }
  }

  // Seconds of cloth, on real time. Added up from clamped steps, so a stall slows it and never jumps.
  var T = 18;
  // The pointer: one exponential, in canvas units. It starts where the pointer is, faded in by `lean`.
  var POINTER = 0.25, mx = 0.5, my = 0.5, lean = 0;
  // The scroll: two exponentials in a row, about 0.25 s together. With one, each wheel notch would start
  // at full speed and show as a step; with two, even the speed is continuous.
  var SCROLL = 0.12, s1 = 0, s2 = 0, flow = 0;
  K.frame(function (now, dt) {
    if (!live) return;
    if (last) quality(now, now - last);
    last = now;
    s1 = K.damp(s1, window.scrollY, SCROLL, dt);
    s2 = K.damp(s2, s1, SCROLL, dt);
    // The gap between the stages is the speed, in screens per second: a fast scroll adds a little flow.
    var speed = Math.abs(s1 - s2) / SCROLL / K.vh;
    flow = K.damp(flow, speed / (1 + speed), 0.4, dt);
    T += dt * (0.1 + 0.2 * flow);
    if (lean < 0.01) {
      mx = tx / cw;
      my = 1 - ty / ch;
    }
    lean = K.damp(lean, inside, POINTER, dt);
    mx = K.damp(mx, tx / cw, POINTER, dt);
    my = K.damp(my, 1 - ty / ch, POINTER, dt);
    var page = s2 / K.vh;
    gl.uniform1f(uT, T + page * 0.3);
    gl.uniform1f(uS, page * 0.9);
    gl.uniform3f(uM, mx, my, lean);
    gl.uniform2f(uL, -0.62 + (mx - 0.5) * lean * 0.24, 0.72 + (my - 0.5) * lean * 0.24);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });

  // After the page is on screen: the hero never waits for the shader.
  function begin() {
    s1 = s2 = window.scrollY;
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
