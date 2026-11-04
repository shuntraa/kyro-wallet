// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the moving silk behind the hero, our own small WebGL shader. It follows the
// pointer, drops its resolution on slow machines and stops off screen. Without WebGL, or with
// reduced motion, the CSS gradient under the canvas stays.
(function () {
  'use strict';

  var canvas = document.querySelector('canvas[data-silk]');
  if (!canvas || !document.documentElement.classList.contains('js')) return;

  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FRAG = [
    'precision mediump float;',
    'uniform vec2 R;uniform float T;uniform vec2 M;uniform float S;',
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
    '  vec2 d=q-m;float near=exp(-dot(d,d)*7.);',
    '  q+=d*near*-.22;',                                // the cloth leans towards the pointer
    '  q=mat2(.8,-.6,.6,.8)*q*2.1+vec2(.4,S*1.6);',
    '  float e=.012;',
    '  float h=cloth(q);',
    '  float hx=cloth(q+vec2(e,0.));float hy=cloth(q+vec2(0.,e));',
    '  vec3 n=normalize(vec3((h-hx)/e*.24,(h-hy)/e*.24,1.));',
    '  vec3 l=normalize(vec3(-.45+m.x*.7,.55+m.y*.7,.75));',
    '  float diff=max(dot(n,l),0.);',
    '  float spec=pow(max(dot(reflect(-l,n),vec3(0.,0.,1.)),0.),18.);',
    '  float v=pow(diff,3.2)*.42+spec*.62+near*.05*(h+1.);',
    '  float vig=smoothstep(1.25,.25,length((uv-vec2(.62,.62))*vec2(1.25,1.)));',
    '  v*=vig;',
    '  v*=mix(.5,1.,smoothstep(.1,.62,uv.x));',           // darker behind the headline
    '  vec3 c=mix(vec3(.74,.82,.9),vec3(.9,.97,1.),v)*v;',
    '  gl_FragColor=vec4(c,1.);',
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
  var uR = gl.getUniformLocation(prog, 'R');
  var uT = gl.getUniformLocation(prog, 'T');
  var uM = gl.getUniformLocation(prog, 'M');
  var uS = gl.getUniformLocation(prog, 'S');

  var scale = window.matchMedia('(pointer: coarse)').matches ? 0.35 : 0.55;
  function resize() {
    var w = Math.max(2, Math.round(canvas.clientWidth * scale));
    var h = Math.max(2, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  window.addEventListener('resize', resize);
  resize();

  var mx = 0.68, my = 0.62, tx = mx, ty = my;
  window.addEventListener(
    'pointermove',
    function (e) {
      var b = canvas.getBoundingClientRect();
      tx = (e.clientX - b.left) / b.width;
      ty = 1 - (e.clientY - b.top) / b.height;
    },
    { passive: true }
  );

  var visible = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (e) {
      visible = e[e.length - 1].isIntersecting;
      if (visible) start();
    }).observe(canvas);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) start();
  });

  var running = false, last = 0, slow = 0, t0 = performance.now();
  function frame(now) {
    if (!visible || document.hidden) {
      running = false;
      return;
    }
    requestAnimationFrame(frame);
    var dt = now - last;
    last = now;
    // A long run of slow frames: fewer pixels first, then keep the gradient and stop.
    slow = dt > 34 ? slow + 1 : Math.max(0, slow - 1);
    if (slow > 45) {
      slow = 0;
      if (scale > 0.2) {
        scale *= 0.7;
        resize();
      } else {
        canvas.classList.remove('on');
        visible = false;
        return;
      }
    }
    mx += (tx - mx) * 0.05;
    my += (ty - my) * 0.05;
    gl.uniform2f(uR, canvas.width, canvas.height);
    gl.uniform1f(uT, (now - t0) / 1000);
    gl.uniform2f(uM, mx, my);
    gl.uniform1f(uS, (window.scrollY || 0) / (window.innerHeight || 800));
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
