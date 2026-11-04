// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the blue satin, our own small WebGL shader on one fixed canvas: a folded height
// field, lit. It only ever knows the time: the scrim that dims it behind the content is plain page
// background, so scrolling stays with the compositor and nothing here reads the scroll position or the
// layout. It draws every frame the display shows, at 60 or 240 Hz alike, into a small buffer that CSS
// scales up, and stops with the tab. Frames that miss vsync shrink the buffer, never the frame rate.
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
    'uniform vec2 R;uniform float T;uniform vec2 L;uniform float W;',
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
    '  vec2 q=(uv-.5)*vec2(R.x/R.y,1.)*mix(4.4,3.8,W)+vec2(.4,.2);',
    // Forward differences: three heights give the slope, and the slope gives the normal.
    '  float h=cloth(q);',
    '  vec2 g=(vec2(cloth(q+vec2(.012,0.)),cloth(q+vec2(0.,.012)))-h)/.012;',
    '  vec3 n=normalize(vec3(-g*.2,1.));',
    // A key light from the top left, a soft fill from the other side, a satin lobe around the tight one.
    '  vec3 l=normalize(vec3(L,.6));',
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
  var uR = gl.getUniformLocation(prog, 'R'), uT = gl.getUniformLocation(prog, 'T'), uL = gl.getUniformLocation(prog, 'L'), uW = gl.getUniformLocation(prog, 'W');

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
    gl.uniform1f(uW, w / h > 1.15 ? 1 : 0);
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
  K.frame(function (now, dt) {
    if (!live) return;
    if (last) quality(now, now - last);
    last = now;
    T += dt * 0.1;
    mx = K.damp(mx, tx, 3, dt);
    my = K.damp(my, ty, 3, dt);
    gl.uniform1f(uT, T);
    gl.uniform2f(uL, -0.62 + mx * 0.1, 0.72 + my * 0.1);
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
