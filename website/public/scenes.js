// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the scroll scenes. Every scene reads the eased position from motion.js (never
// scrollY) and damps its own progress on top, against real time, so a wheel notch and a 240 Hz
// screen look the same as a trackpad at 60 Hz. No layout reads in a frame. With reduced motion
// nothing here starts: the HTML already holds each scene's final state.
(function () {
  'use strict';

  var K = window.Kyro;
  if (!K) return;
  var P = (K.p = {}); // each scene's current progress
  var damp = K.damp;
  var clamp = function (v, a, b) {
    return v < a ? a : v > b ? b : v;
  };
  var lerp = function (a, b, t) {
    return a + (b - a) * t;
  };
  var seg = function (p, a, b) {
    return clamp((p - a) / (b - a), 0, 1);
  };
  var smooth = function (t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  };
  var out = function (t) {
    return 1 - Math.pow(1 - t, 3);
  };

  // Track geometry is measured on resize, never inside a frame.
  var tracks = [];
  var vh = K.vh;
  var PIN = '(min-height: 560px)'; // every portrait phone pins; a phone on its side reads as a page
  function measure(t) {
    var b = t.el.getBoundingClientRect();
    t.top = b.top + window.scrollY;
    t.h = b.height;
  }
  function track(el) {
    var t = { el: el, top: 0, h: 0 };
    tracks.push(t);
    measure(t);
    return t;
  }
  function remeasure() {
    vh = K.vh;
    tracks.forEach(measure);
  }
  K.resize(remeasure);
  window.addEventListener('load', remeasure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);
  if (window.ResizeObserver) new ResizeObserver(remeasure).observe(document.body);

  /** 0 when the track's top reaches the viewport top, 1 when its bottom reaches the viewport bottom. */
  function pinned(t, y) {
    return clamp((y - t.top) / Math.max(1, t.h - vh), 0, 1);
  }
  /** 0 when the track enters the viewport, 1 when it leaves. For scenes that do not pin. */
  function passing(t, y) {
    return clamp((y + vh - t.top) / (vh + t.h), 0, 1);
  }
  function near(t, y) {
    return y + vh + 300 > t.top && y < t.top + t.h + 300;
  }
  function text(el, v) {
    if (el.textContent !== v) el.textContent = v;
  }
  function fade(el, v) {
    if (el.__o !== v) {
      el.__o = v;
      el.style.opacity = v;
    }
  }

  // Additive light on a small canvas: sparks and rings, shared by the scenes below.
  function FX(canvas) {
    var ctx = canvas.getContext('2d');
    var parts = [], rings = [], w = 0, h = 0, drawn = false;
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    function size() {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    size();
    K.resize(size);
    return {
      burst: function (x, y, n, speed) {
        for (var i = 0; i < n; i++) {
          var a = Math.random() * 6.283, v = speed * (0.25 + Math.random() * 0.75);
          parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, fade: 0.012 + Math.random() * 0.02, r: 0.8 + Math.random() * 2.2 });
        }
      },
      ring: function (x, y, max) {
        rings.push({ x: x, y: y, r: 0, max: max, life: 1 });
      },
      /** Runs one frame. extra(ctx) draws scene light in the same pass; it returns true while it drew. */
      tick: function (dt, extra) {
        var keep = parts.length || rings.length;
        if (!keep && !extra && !drawn) return;
        var k = dt * 60;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        drawn = false;
        if (extra) drawn = extra(ctx, w, h) || drawn;
        for (var i = rings.length - 1; i >= 0; i--) {
          var g = rings[i];
          g.r = damp(g.r, g.max, 0.2, dt);
          g.life -= 0.024 * k;
          if (g.life <= 0) {
            rings.splice(i, 1);
            continue;
          }
          ctx.strokeStyle = 'rgba(124,196,255,' + (g.life * 0.8).toFixed(3) + ')';
          ctx.lineWidth = 1 + g.life * 3;
          ctx.beginPath();
          ctx.arc(g.x, g.y, g.r, 0, 6.283);
          ctx.stroke();
          drawn = true;
        }
        var drag = Math.pow(0.97, k);
        for (var j = parts.length - 1; j >= 0; j--) {
          var p = parts[j];
          p.x += p.vx * k;
          p.y += p.vy * k;
          p.vx *= drag;
          p.vy *= drag;
          p.life -= p.fade * k;
          if (p.life <= 0) {
            parts.splice(j, 1);
            continue;
          }
          ctx.fillStyle = 'rgba(165,218,255,' + p.life.toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, 6.283);
          ctx.fill();
          ctx.fillStyle = 'rgba(124,196,255,' + (p.life * 0.16).toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 4, 0, 6.283);
          ctx.fill();
          drawn = true;
        }
      },
      w: function () {
        return w;
      }
    };
  }

  // ---------- hero: the window, its screens and the story under it
  function story() {
    var el = document.querySelector('[data-story]');
    if (!el) return;
    var wrap = el.querySelector('[data-kw]');
    var copy = el.querySelector('[data-copy]');
    var ui = el.querySelector('[data-ui]');
    var caps = el.querySelectorAll('[data-caption] span');
    var screens = el.querySelectorAll('[data-screen]');
    var rails = el.querySelectorAll('[data-rail]');
    var dots = el.querySelectorAll('[data-go]');
    var balance = el.querySelector('[data-balance]');
    var from = el.querySelector('[data-sw-from]');
    var to = el.querySelector('[data-sw-to]');
    var eye = el.querySelector('[data-eye]');
    var plain = el.querySelectorAll('[data-screen="0"] .v');
    var hidden = el.querySelectorAll('[data-screen="0"] .d');
    var ring = el.querySelector('[data-ring]');
    var sq = el.querySelector('[data-sq]');
    var pglow = el.querySelector('[data-pglow]');
    var bars = el.querySelectorAll('#hero-title .bar');
    var current = -1, lastMask = -1;
    var tr = track(el);

    function show(i) {
      if (i === current) return;
      current = i;
      for (var r = 0; r < rails.length; r++) rails[r].classList.toggle('on', +rails[r].getAttribute('data-rail') === i);
      for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('on', d === i);
    }
    function setScreen(i, opacity, x) {
      var s = screens[i];
      // Never quite 0: a layer the browser has already drawn costs nothing when it appears.
      fade(s, Math.max(0.002, +opacity.toFixed(3)));
      s.style.transform = 'translate3d(' + x.toFixed(1) + 'px,0,0)';
    }
    function captions(a, b, c, d) {
      fade(caps[0], +a.toFixed(3));
      fade(caps[1], +b.toFixed(3));
      fade(caps[2], +c.toFixed(3));
      fade(caps[3], +d.toFixed(3));
    }

    if (!K.motion) {
      // Reduced motion: no cycling, the buttons switch screens.
      Array.prototype.forEach.call(dots, function (b, i) {
        b.addEventListener('click', function () {
          for (var s = 0; s < screens.length; s++) screens[s].classList.toggle('is-on', s === i);
          show(i);
          captions(i === 0 ? 1 : 0, 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
        });
      });
      show(0);
      return;
    }

    el.querySelector('.kw-in').classList.add('draw');
    (function count(t0) {
      (function tick(now) {
        var t = clamp((now - t0) / 1800, 0, 1);
        balance.textContent = Math.round(12345 * lerp(0.62, 1, out(t))).toLocaleString('en-US');
        if (t < 1) requestAnimationFrame(tick);
      })(t0);
    })(performance.now());

    var wide = window.matchMedia(PIN);
    var wrapW = 1, wrapH = 1, p = 0, sq0 = 1, ring0 = window.innerWidth < 1100 ? 0.1833 : 0.2125, holeY = 0;
    // Screen changes sit on the track with a wide crossfade: several notches long.
    var SWAP = 0.52, EARN = 0.77, X = 0.055;
    var earnRows = Array.prototype.map.call(el.querySelectorAll('.kw-earn'), function (r) {
      var num = r.querySelector('[data-rate]');
      return { el: r, num: num, bar: r.querySelector('.kw-ratebar i'), rate: +num.getAttribute('data-rate'), k: -1 };
    });

    function pinnedFrame(y, dt) {
      // Off screen the value simply follows, so coming back never starts from a stale place.
      if (!near(tr, y)) {
        P.story = p = pinned(tr, y);
        return;
      }
      p = damp(p, pinned(tr, y), 0.1, dt);
      P.story = p;
      // The headline goes back behind its bars, word after word.
      for (var i = 0; i < bars.length; i++) bars[i].style.transform = 'scaleX(' + smooth(seg(p, 0.004 + i * 0.009, 0.04 + i * 0.009)).toFixed(4) + ')';
      var c = seg(p, 0.05, 0.095);
      fade(copy, +(1 - smooth(c)).toFixed(3));
      var cv = c < 1;
      if (copy.__v !== cv) {
        copy.__v = cv;
        copy.style.visibility = cv ? 'visible' : 'hidden';
      }
      // Then the mark opens: the ring flies past, the ice square grows into the wallet.
      var e = smooth(seg(p, 0.05, 0.22));
      var dy = holeY * (1 - e);
      var rs = ring0 * Math.pow(1.8 / ring0, e);
      ring.style.transform = 'translate3d(0,' + dy.toFixed(2) + 'px,0) scale(' + rs.toFixed(4) + ')';
      fade(ring, +(1 - smooth(seg(p, 0.13, 0.2))).toFixed(3));
      var ws = Math.pow(wrapW / sq0, e), hs = Math.pow(wrapH / sq0, e);
      sq.style.transform = 'translate3d(0,' + dy.toFixed(2) + 'px,0) scale(' + ws.toFixed(3) + ',' + hs.toFixed(3) + ')';
      fade(sq, +(1 - smooth(seg(p, 0.165, 0.225))).toFixed(3));
      pglow.style.transform = 'translate3d(0,' + dy.toFixed(2) + 'px,0) scale(' + (1 + e * 2.4).toFixed(3) + ')';
      fade(pglow, +(1 - smooth(seg(p, 0.17, 0.27))).toFixed(3));
      var kw = sq0 / wrapW;
      wrap.style.transform = 'translate3d(0,' + dy.toFixed(2) + 'px,0) scale(' + (kw * Math.pow(1 / kw, e)).toFixed(4) + ')';
      fade(wrap, Math.max(0.004, +smooth(seg(p, 0.145, 0.195)).toFixed(3)));
      fade(ui, +smooth(seg(p, 0.2, 0.25)).toFixed(3));
      ui.classList.toggle('live', p > 0.2);

      var a = smooth(seg(p, SWAP - X, SWAP + X));
      var b = smooth(seg(p, EARN - X, EARN + X));
      var w = wrapW * 0.05;
      setScreen(0, 1 - a, -a * w);
      setScreen(1, a * (1 - b), (1 - a) * w - b * w);
      setScreen(2, b, (1 - b) * w);
      show(b > 0.5 ? 2 : a > 0.5 ? 1 : 0);

      // The app's Hide balances: the numbers dim into dots, then come back.
      var m = smooth(seg(p, 0.33, 0.37)) * (1 - smooth(seg(p, 0.42, 0.46)));
      var mk = +m.toFixed(3);
      if (mk !== lastMask) {
        lastMask = mk;
        for (var v = 0; v < plain.length; v++) plain[v].style.opacity = 1 - mk;
        for (var d = 0; d < hidden.length; d++) hidden[d].style.opacity = mk;
        if (eye) eye.classList.toggle('on', mk > 0.5);
      }
      captions((1 - a) * (1 - m), (1 - a) * m, a * (1 - b), b);

      // The swap fills in as you scroll through it.
      var s = smooth(seg(p, SWAP, SWAP + 0.15));
      text(from, lerp(0, 1, s).toFixed(4));
      text(to, lerp(0, 100, s).toFixed(2));

      // Earn: the rows arrive in turn and their rates count up.
      for (var e = 0; e < earnRows.length; e++) {
        var k = smooth(seg(p, EARN - 0.02 + e * 0.022, EARN + 0.1 + e * 0.022));
        var row = earnRows[e];
        if (row.k === k) continue;
        row.k = k;
        fade(row.el, +k.toFixed(3));
        row.el.style.transform = 'translate3d(0,' + ((1 - k) * 14).toFixed(1) + 'px,0)';
        row.bar.style.transform = 'scaleX(' + k.toFixed(3) + ')';
        text(row.num, (row.rate * k).toFixed(2) + '%');
      }
    }

    // Small screens: no pin. The window sits in the page and cycles by itself.
    var timer = 0, idx = 0;
    function cycleTo(i) {
      idx = i;
      for (var s = 0; s < screens.length; s++) setScreen(s, s === i ? 1 : 0, 0);
      show(i);
      captions(i === 0 ? 1 : 0, 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
    }
    function startCycle() {
      if (timer) return;
      timer = window.setInterval(function () {
        if (!document.hidden && near(tr, K.y)) cycleTo((idx + 1) % screens.length);
      }, 4800);
    }
    function stopCycle() {
      window.clearInterval(timer);
      timer = 0;
    }
    function layout() {
      wrapW = wrap.offsetWidth;
      wrapH = wrap.offsetHeight;
      sq0 = sq.offsetWidth;
      ring0 = window.innerWidth < 1100 ? 0.1833 : 0.2125;
      holeY = -K.vh * (window.innerWidth < 1100 ? 0.245 : 0.165); // the mark sits above the middle at first
      if (wide.matches) {
        stopCycle();
      } else {
        [wrap, copy, ui, ring, sq, pglow].forEach(function (n) {
          n.style.cssText = '';
          n.__o = n.__v = undefined;
        });
        for (var i = 0; i < bars.length; i++) bars[i].style.transform = '';
        cycleTo(idx);
        startCycle();
      }
    }
    K.resize(layout);
    layout();
    show(0);
    p = pinned(tr, K.y);

    Array.prototype.forEach.call(dots, function (btn, i) {
      btn.addEventListener('click', function () {
        if (wide.matches) {
          var stops = [0.29, 0.64, 0.93];
          K.scrollTo(tr.top + stops[i] * (tr.h - vh));
        } else {
          stopCycle();
          cycleTo(i);
        }
      });
    });

    K.frame(function (y, now, dt) {
      if (wide.matches) pinnedFrame(y, dt);
    });
  }

  // ---------- Tor: the packet crosses three relays and the address disappears
  function tor() {
    var el = document.querySelector('[data-tor]');
    if (!el || !K.motion) return;
    var ip = el.querySelector('[data-ip]');
    var note = el.querySelector('[data-ip-note]');
    var packet = el.querySelector('[data-packet]');
    var fill = el.querySelector('[data-rt-fill]');
    var rings = packet.querySelectorAll('i');
    var hops = el.querySelectorAll('[data-hop]');
    var rt = el.querySelector('.rt');
    var pin = window.matchMedia(PIN);
    var OCT = ['203', '0', '113', '42'];
    var NOTES = ['Your address (example)', 'Hidden behind relay 1', 'Hidden behind relay 2', 'Hidden behind relay 3', 'A Tor exit relay'];
    var GLYPH = '0123456789';

    ip.textContent = '';
    var cells = OCT.map(function (o, i) {
      var s = document.createElement('span');
      s.textContent = o;
      ip.appendChild(s);
      if (i < 3) ip.appendChild(document.createTextNode('.'));
      return s;
    });
    // The five notes sit on top of each other and crossfade with the packet.
    note.textContent = '';
    note.classList.add('ip-stack');
    var notes = NOTES.map(function (n) {
      var s = document.createElement('span');
      s.textContent = n;
      note.appendChild(s);
      return s;
    });

    var lastFrame = 0, span = 0, x0 = 0, lastHop = 0, tailX = 0, px = 0, py = 27, p = 0;
    var tr = track(el);
    var fx = FX(el.querySelector('.rt .fx'));
    function comet(ctx) {
      var len = px - tailX;
      if (Math.abs(len) < 1) return false;
      var g = ctx.createLinearGradient(tailX, 0, px, 0);
      g.addColorStop(0, 'rgba(124,196,255,0)');
      g.addColorStop(0.7, 'rgba(124,196,255,.45)');
      g.addColorStop(1, 'rgba(225,244,255,1)');
      ctx.strokeStyle = g;
      ctx.lineCap = 'round';
      ctx.lineWidth = 9;
      ctx.globalAlpha = 0.28;
      ctx.beginPath();
      ctx.moveTo(tailX, py);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.lineWidth = 2.6;
      ctx.globalAlpha = 1;
      ctx.stroke();
      return true;
    }
    function size() {
      span = rt.offsetWidth * 0.8;
      x0 = rt.offsetWidth * 0.1;
      py = window.innerWidth <= 640 ? 20 : 27;
    }
    size();
    K.resize(size);
    tailX = px = x0;

    K.frame(function (y, now, dt) {
      var goal = pin.matches ? pinned(tr, y) : clamp((passing(tr, y) - 0.25) / 0.45, 0, 1);
      if (!near(tr, y)) {
        P.tor = p = goal;
        lastHop = Math.floor(seg(p, 0.05, 0.93) * 4);
        return;
      }
      p = damp(p, goal, 0.11, dt);
      P.tor = p;
      var t = seg(p, 0.05, 0.93); // 0 at Kyro, 1 at the network
      packet.style.transform = 'translate3d(' + (t * span).toFixed(2) + 'px,0,0)';
      fade(packet, +(smooth(seg(p, 0, 0.05)) * (1 - smooth(seg(p, 0.95, 1)))).toFixed(3));
      fill.style.transform = 'scaleX(' + t.toFixed(4) + ')';

      var hop = t * 4; // 0, 1, 2, 3, 4 at the five nodes
      px = x0 + t * span;
      tailX = damp(tailX, px, 0.16, dt);
      if (Math.floor(hop) > lastHop && hop >= 1) {
        // The packet reached a relay: the node rings and throws sparks.
        fx.ring(px, py, 120);
        fx.ring(px, py, 70);
        fx.burst(px, py, 26, 3.4);
        var node = hops[Math.floor(hop)];
        if (node) {
          node.classList.remove('pulse');
          void node.clientWidth;
          node.classList.add('pulse');
        }
      }
      lastHop = Math.floor(hop);
      if (p > 0.02 && p < 0.97 && Math.abs(px - tailX) > 8 && Math.random() < 30 * dt) fx.burst(px, py, 1, 1.1);
      fx.tick(dt, comet);

      for (var h = 0; h < hops.length; h++) hops[h].classList.toggle('lit', hop >= h - 0.04);
      for (var r = 0; r < rings.length; r++) rings[r].classList.toggle('off', hop >= 3 - r); // one layer per relay

      var step = now - lastFrame > 70;
      if (step) lastFrame = now;
      for (var c = 0; c < 4; c++) {
        // Each octet scrambles as the packet reaches a hop, then it is gone.
        var at = c + 0.6;
        var cell = cells[c];
        if (hop >= at + 0.4) {
          if (cell.className !== 'gone') {
            cell.className = 'gone';
            cell.textContent = '•••';
          }
        } else if (hop >= at - 0.2) {
          if (step) {
            cell.className = 'hot';
            var s = '';
            for (var k = 0; k < 3; k++) s += GLYPH[(Math.random() * 10) | 0];
            cell.textContent = s;
          }
        } else if (cell.className || cell.textContent !== OCT[c]) {
          cell.className = '';
          cell.textContent = OCT[c];
        }
      }
      for (var n = 0; n < 5; n++) fade(notes[n], +clamp(1.6 - Math.abs(hop - n - 0.1) * 2.6, 0, 1).toFixed(3));
    });
  }

  // ---------- coin field: every coin drifts in depth, then they form the Kyro mark
  function gather() {
    var el = document.querySelector('[data-gather]');
    if (!el || !K.motion) return;
    var coins = el.querySelectorAll('.fc');
    var mark = el.querySelector('[data-mark]');
    var cta = el.querySelector('[data-cta]');
    var pinBox = el.querySelector('.gather-pin');
    var glowPos = el.querySelector('[data-glowpos]');
    var glow = el.querySelector('[data-glow]');
    var fx = FX(el.querySelector('.gather-pin > .fx'));
    var N = coins.length;
    var CENTER = 9; // a 3 x 3 block makes the square in the mark
    var mx = 0, my = 0, tx = 0, ty = 0, p = 0, flashed = false, first = true;
    var items = [];
    var tr = track(el);
    var W = 0, H = 0, unit = 1, markBase = 1, markY = 0;

    function build() {
      W = pinBox.clientWidth;
      H = pinBox.clientHeight;
      unit = Math.min(W * (W < 700 ? 0.3 : 0.2), H * 0.27) / 20;
      markBase = mark.offsetWidth;
      markY = mark.offsetTop + mark.offsetHeight / 2;
      var size = W < 700 ? 34 : 54;
      var arc = N - CENTER;
      var old = items;
      items = [];
      for (var i = 0; i < N; i++) {
        var gx, gy, end;
        if (i < arc) {
          // Two staggered lanes along the open ring (from 42 to 318 degrees).
          var a = ((42 + (276 * i) / (arc - 1)) * Math.PI) / 180;
          var lane = i % 2 ? 2.3 : -2.3;
          gx = Math.cos(a) * (20 + lane) * unit;
          gy = Math.sin(a) * (20 + lane) * unit;
          end = 5.4;
        } else {
          var j = i - arc;
          gx = ((j % 3) - 1) * 4.1 * unit;
          gy = (((j / 3) | 0) - 1) * 4.1 * unit;
          end = 3.9;
        }
        // Golden-angle scatter fills the frame evenly; depth drives size, drift and parallax.
        var ang = i * 2.39996;
        var rad = 0.32 + 0.68 * Math.sqrt((i + 0.5) / N);
        var z = ((i * 37) % 100) / 100;
        var prev = old[i] || {};
        items.push({
          el: coins[i],
          sx: Math.cos(ang) * rad * W * 0.56,
          sy: Math.sin(ang) * rad * H * 0.56,
          gx: gx,
          gy: gy,
          z: z,
          base: (lerp(0.55, 1.5, z) * size) / 64,
          end: (unit * end) / 64,
          ph: i * 1.7,
          spin: ((i * 53) % 40) - 20,
          start: 0.04 + (((i * 13) % N) / N) * 0.26,
          tau: 0.14 + z * 0.16,
          x: prev.x,
          y: prev.y,
          s: prev.s
        });
      }
    }
    build();
    K.resize(build);
    if (K.fine) {
      window.addEventListener(
        'pointermove',
        function (e) {
          tx = e.clientX / window.innerWidth - 0.5;
          ty = e.clientY / K.vh - 0.5;
        },
        { passive: true }
      );
    }

    K.frame(function (y, now, dt) {
      if (!near(tr, y)) {
        first = true;
        P.gather = p = pinned(tr, y);
        return;
      }
      p = first ? pinned(tr, y) : damp(p, pinned(tr, y), 0.13, dt);
      P.gather = p;
      if (!K.fine) {
        ty = clamp(K.v / 3000, -0.5, 0.5); // the crowd leans with the swipe
        tx = Math.sin(p * 5) * 0.2;
      }
      mx = damp(mx, tx, 0.22, dt);
      my = damp(my, ty, 0.22, dt);
      var time = now / 1000;
      var hand = smooth(seg(p, 0.68, 0.78)); // coins hand over to the solid mark
      var vis = smooth(seg(p, 0, 0.1));
      for (var i = 0; i < N; i++) {
        var c = items[i];
        var g = smooth(seg(p, c.start, c.start + 0.38));
        var depth = (c.z + 0.25) * (1 - g);
        var gx = lerp(c.sx + Math.sin(time * 0.5 + c.ph) * 16 * depth - mx * 150 * depth, c.gx, g);
        var gy = lerp(c.sy + Math.cos(time * 0.42 + c.ph) * 16 * depth - my * 110 * depth + (0.5 - p) * 260 * depth, c.gy, g) - 30;
        var gs = lerp(c.base, c.end, g);
        // Each coin eases to its own target at its own speed, so the crowd flows.
        if (first || c.x === undefined) {
          c.x = gx;
          c.y = gy;
          c.s = gs;
        } else {
          c.x = damp(c.x, gx, c.tau, dt);
          c.y = damp(c.y, gy, c.tau, dt);
          c.s = damp(c.s, gs, c.tau, dt);
        }
        c.el.style.transform = 'translate3d(' + c.x.toFixed(2) + 'px,' + c.y.toFixed(2) + 'px,0) rotate(' + ((1 - g) * c.spin).toFixed(2) + 'deg) scale(' + c.s.toFixed(4) + ')';
        fade(c.el, +(vis * lerp(lerp(0.4, 1, c.z), 1, g) * (1 - hand)).toFixed(3));
      }
      first = false;
      P.coinX = items[7].x;
      P.coinY = items[7].y;
      P.coinO = items[7].el.__o;
      // The mark appears on the coins, at the centre of the frame, then moves up to make room.
      var rise = smooth(seg(p, 0.75, 0.9));
      var ctaIn = smooth(seg(p, 0.81, 0.97));
      var big = (unit * 64) / markBase;
      var shift = (H / 2 - 30 - markY) * (1 - rise);
      fade(mark, +hand.toFixed(3));
      mark.style.transform = 'translate3d(0,' + shift.toFixed(2) + 'px,0) scale(' + lerp(big, 1, rise).toFixed(4) + ')';
      glowPos.style.transform = 'translate3d(0,' + (markY + shift).toFixed(2) + 'px,0)';
      fade(cta, +ctaIn.toFixed(3));
      cta.style.transform = 'translate3d(0,' + ((1 - ctaIn) * 40).toFixed(1) + 'px,0)';
      cta.style.pointerEvents = ctaIn > 0.5 ? '' : 'none';
      cta.classList.toggle('in', ctaIn > 0.5);
      // The moment the coins become the logo: one flash, sparks, then the logo breathes.
      if (p > 0.72 && !flashed) {
        flashed = true;
        glow.classList.remove('flash');
        void glow.clientWidth;
        glow.classList.add('flash');
        var cx = W / 2, cy = H / 2 - 30;
        fx.burst(cx, cy, 150, Math.min(W, H) * 0.016);
        fx.ring(cx, cy, Math.min(W, H) * 0.5);
        fx.ring(cx, cy, Math.min(W, H) * 0.34);
      } else if (p < 0.62) {
        flashed = false;
      }
      glowPos.classList.toggle('alive', p > 0.76);
      fx.tick(dt);
    });
  }

  // ---------- the blockchains: a sheet in the dark, lit by a beam that passes as you scroll
  function wallScene() {
    var el = document.querySelector('[data-wall]');
    if (!el || !K.motion) return;
    var tr = track(el);
    var tiles = [], W = 1, H = 1, top = 0, p = 0, px = -1, py = -1, ux = 0, uy = 0, over = 0;
    function size() {
      var b = el.getBoundingClientRect();
      W = b.width;
      H = b.height;
      top = b.top + window.scrollY;
      tiles = Array.prototype.map.call(el.querySelectorAll('.wall-t'), function (t) {
        var r = t.getBoundingClientRect();
        return { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2, img: t.querySelector('img'), glow: t.querySelector('.wall-l') };
      });
    }
    size();
    K.resize(size);
    window.addEventListener('load', size);
    if (K.fine) {
      el.addEventListener('pointermove', function (e) {
        var b = el.getBoundingClientRect();
        px = e.clientX - b.left;
        py = e.clientY - b.top;
      });
      el.addEventListener('pointerleave', function () {
        px = py = -1;
      });
    }
    K.frame(function (y, now, dt) {
      if (!near(tr, y)) return;
      p = damp(p, passing(tr, y), 0.14, dt);
      var t = now / 1000;
      // The beam crosses the sheet with the scroll and keeps drifting on its own.
      var bx = W * (0.5 + 0.46 * Math.sin(p * 7 + t * 0.32));
      var by = H * clamp(1.25 * p - 0.12 + 0.12 * Math.sin(t * 0.5), 0, 1);
      over = damp(over, px >= 0 ? 1 : 0, 0.16, dt);
      if (px >= 0) {
        ux = damp(ux, px, 0.1, dt);
        uy = damp(uy, py, 0.1, dt);
      }
      bx = lerp(bx, ux, over);
      by = lerp(by, uy, over);
      var r2 = 2 * Math.pow(Math.min(W, 900) * 0.2, 2);
      for (var i = 0; i < tiles.length; i++) {
        var c = tiles[i], dx = c.x - bx, dyy = c.y - by;
        var l = Math.exp(-(dx * dx + dyy * dyy) / r2);
        fade(c.img, +(0.3 + 0.7 * l).toFixed(2));
        fade(c.glow, +l.toFixed(2));
      }
    });
  }

  // ---------- Earn list on the page: rates count up, bars light in turn
  function earn() {
    var box = document.querySelector('[data-rows]');
    if (!box || !K.motion) return;
    var rows = box.querySelectorAll('.kw-earn');
    var io = new IntersectionObserver(
      function (e) {
        if (!e[e.length - 1].isIntersecting) return;
        io.disconnect();
        Array.prototype.forEach.call(rows, function (r, i) {
          var num = r.querySelector('[data-rate]');
          var rate = +num.getAttribute('data-rate');
          var t0 = performance.now() + i * 90;
          num.textContent = '0.00%';
          (function tick(now) {
            var t = clamp((now - t0) / 1100, 0, 1);
            text(num, (rate * out(t)).toFixed(2) + '%');
            if (t < 1) requestAnimationFrame(tick);
          })(t0);
        });
      },
      { threshold: 0.2 }
    );
    io.observe(box);
  }

  // ---------- Ledger: the device asks, you answer, the coins connect one by one
  function ledger() {
    var list = document.querySelectorAll('[data-ledger]');
    if (!list.length || !K.motion) return;
    var pin = window.matchMedia(PIN);
    Array.prototype.forEach.call(list, function (root) {
      var owner = root.closest('[data-ledger-track]');
      var tr = track(owner || root);
      var stage = root.querySelector('.lg-stage');
      var nodes = root.querySelectorAll('.lg-n');
      var screensEl = root.querySelectorAll('.lg-s');
      var halo = root.querySelector('.lg-halo');
      var yes = root.querySelector('[data-lg-yes]');
      var steps = owner ? owner.querySelectorAll('.hw-steps li') : [];
      var count = owner ? owner.querySelector('[data-ledger-n]') : null;
      var total = count ? +count.textContent : 0;
      var fx = FX(root.querySelector('.fx'));
      var p = 0, mx = 0, my = 0, tx = 0, ty = 0, stage0 = -1;
      var DEV = { l: 232, r: 408, t: 124, b: 432 };

      // Each wire as points in the drawing's 640 x 560 space, from the coin's rim to the device's edge.
      var wires = Array.prototype.map.call(root.querySelectorAll('.lg-l'), function (path, i) {
        var m = /M(\d+) (\d+)Q(\d+) (\d+) (\d+) (\d+)/.exec(path.getAttribute('d')).slice(1).map(Number);
        var pts = [];
        for (var k = 0; k <= 40; k++) {
          var t = k / 40, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
          var x = a * m[0] + b * m[2] + c * m[4], y = a * m[1] + b * m[3] + c * m[5];
          if (Math.hypot(x - m[0], y - m[1]) < 34) continue;
          if (x > DEV.l && x < DEV.r && y > DEV.t && y < DEV.b) break;
          pts.push([x, y]);
        }
        return { pts: pts, k: 0, x: m[0], y: m[1], node: nodes[i] };
      });
      function draw(ctx, w) {
        var s = w / 640;
        ctx.lineCap = 'round';
        for (var i = 0; i < wires.length; i++) {
          var wire = wires[i];
          if (wire.k <= 0.004) continue;
          var n = Math.max(2, Math.ceil(wire.pts.length * wire.k));
          ctx.beginPath();
          ctx.moveTo(wire.pts[0][0] * s, wire.pts[0][1] * s);
          for (var j = 1; j < n; j++) ctx.lineTo(wire.pts[j][0] * s, wire.pts[j][1] * s);
          ctx.strokeStyle = 'rgba(124,196,255,.2)';
          ctx.lineWidth = 7 * s;
          ctx.stroke();
          ctx.strokeStyle = 'rgba(190,228,255,.95)';
          ctx.lineWidth = 1.8 * s;
          ctx.stroke();
          ctx.strokeStyle = 'rgba(124,196,255,' + (wire.k * 0.45).toFixed(3) + ')';
          ctx.lineWidth = 7 * s;
          ctx.beginPath();
          ctx.arc(wire.x * s, wire.y * s, 34 * s, 0, 6.283);
          ctx.stroke();
        }
        return true;
      }
      if (K.fine) {
        window.addEventListener(
          'pointermove',
          function (e) {
            tx = e.clientX / window.innerWidth - 0.5;
            ty = e.clientY / K.vh - 0.5;
          },
          { passive: true }
        );
      }
      K.frame(function (y, now, dt) {
        var goal = owner && pin.matches ? pinned(tr, y) : clamp((passing(tr, y) - 0.2) / 0.5, 0, 1);
        if (!near(tr, y)) {
          p = goal;
          if (owner) P.hw = p;
          return;
        }
        p = damp(p, goal, 0.12, dt);
        if (owner) P.hw = p;
        if (!K.fine) {
          tx = Math.sin(p * 6.3) * 0.32;
          ty = Math.cos(p * 4.1) * 0.22;
        }
        mx = damp(mx, tx, 0.2, dt);
        my = damp(my, ty, 0.2, dt);
        stage.style.transform = 'perspective(1100px) rotateY(' + (mx * 16).toFixed(2) + 'deg) rotateX(' + (-my * 12).toFixed(2) + 'deg)';
        for (var i = 0; i < wires.length; i++) {
          var k = smooth(seg(p, 0.08 + i * 0.066, 0.2 + i * 0.066));
          wires[i].k = k;
          fade(wires[i].node, +(0.42 + 0.58 * k).toFixed(3));
        }
        // Four screens, crossfading on the track.
        var w0 = 1 - smooth(seg(p, 0.23, 0.29));
        var w1 = smooth(seg(p, 0.23, 0.29)) * (1 - smooth(seg(p, 0.49, 0.55)));
        var w2 = smooth(seg(p, 0.49, 0.55)) * (1 - smooth(seg(p, 0.77, 0.83)));
        var w3 = smooth(seg(p, 0.77, 0.83));
        fade(screensEl[0], +w0.toFixed(3));
        fade(screensEl[1], +w1.toFixed(3));
        fade(screensEl[2], +w2.toFixed(3));
        fade(screensEl[3], +w3.toFixed(3));
        fade(halo, +(0.55 + 0.45 * w3).toFixed(3));
        var s = p < 0.26 ? 0 : p < 0.52 ? 1 : p < 0.8 ? 2 : 3;
        if (s !== stage0) {
          if (s > stage0 && stage0 >= 0) {
            yes.classList.remove('press');
            void root.clientWidth;
            yes.classList.add('press');
          }
          if (s === 3 && stage0 === 2) {
            var w = fx.w();
            fx.ring(w / 2, w * 0.4, w * 0.5);
            fx.burst(w / 2, w * 0.36, 70, w * 0.012);
          }
          stage0 = s;
        }
        for (var n = 0; n < steps.length; n++) steps[n].classList.toggle('on', s >= (n === 0 ? 0 : n === 1 ? 1 : 2));
        if (count) text(count, String(Math.round(total * smooth(seg(p, 0.06, 0.84)))));
        fx.tick(dt, draw);
      });
    });
  }

  // ---------- swap: one coin turns into the other while the amounts count
  function swap() {
    var list = document.querySelectorAll('[data-swap]');
    if (!list.length || !K.motion) return;
    // A loop: each swap starts from what the last one received, so the coin never has to jump.
    var PAIRS = [
      ['btc', 'BTC', 1, 'xmr', 'XMR', 100, 4, 2],
      ['xmr', 'XMR', 100, 'eth', 'ETH', 12.34, 2, 2],
      ['eth', 'ETH', 12.34, 'sol', 'SOL', 123.45, 2, 2],
      ['sol', 'SOL', 123.45, 'btc', 'BTC', 1, 2, 4]
    ];
    Array.prototype.forEach.call(list, function (el) {
      var spin = el.querySelector('[data-spin]');
      var front = el.querySelector('[data-f]');
      var back = el.querySelector('[data-b]');
      var a = el.querySelector('[data-a]');
      var at = el.querySelector('[data-at]');
      var b = el.querySelector('[data-bn]');
      var bt = el.querySelector('[data-bt]');
      var rate = el.querySelector('[data-rate]');
      var i = 0, seen = false, t0 = 0, base = 0, landed = false, flipped = false;
      var fx = FX(el.querySelector('.fx'));
      var coinBox = el.querySelector('.sw-coin');
      var HOLD = 1500, TURN = 1500;

      function set(pair) {
        a.textContent = pair[2].toLocaleString('en-US', { minimumFractionDigits: pair[6], maximumFractionDigits: pair[6] });
        at.textContent = pair[1];
        bt.textContent = pair[4];
        var r = pair[5] / pair[2];
        rate.textContent = '1 ' + pair[1] + ' ≈ ' + (r >= 1 ? Math.round(r).toLocaleString('en-US') : r.toFixed(4)) + ' ' + pair[4];
      }
      function faces(pair, f) {
        // The hidden face is the one to change: it is swapped while it cannot be seen.
        (f ? front : back).src = '/img/coins/' + pair[3] + '.svg';
        (f ? back : front).src = '/img/coins/' + pair[0] + '.svg';
      }
      new IntersectionObserver(function (e) {
        seen = e[e.length - 1].isIntersecting;
      }).observe(el);

      set(PAIRS[0]);
      K.frame(function (y, now, dt) {
        if (!seen) {
          t0 = 0;
          return;
        }
        if (!t0) t0 = now;
        var pair = PAIRS[i];
        var e = now - t0;
        var t = clamp((e - HOLD) / TURN, 0, 1);
        var k = smooth(t);
        // Three half turns: the coin ends on its other face.
        spin.style.transform = 'rotateY(' + (base + k * 540).toFixed(2) + 'deg) scale(' + (1 + Math.sin(t * Math.PI) * 0.14).toFixed(3) + ')';
        text(b, (pair[5] * k).toLocaleString('en-US', { minimumFractionDigits: pair[7], maximumFractionDigits: pair[7] }));
        if (t >= 1 && !landed) {
          landed = true;
          var bx = coinBox.offsetLeft + coinBox.offsetWidth / 2;
          var by = coinBox.offsetTop + coinBox.offsetHeight / 2;
          fx.ring(bx, by, coinBox.offsetWidth * 1.3);
          fx.ring(bx, by, coinBox.offsetWidth * 0.9);
          fx.burst(bx, by, 70, coinBox.offsetWidth * 0.075);
          el.classList.remove('landed');
          void el.clientWidth;
          el.classList.add('landed');
        }
        fx.tick(dt);
        if (e > HOLD + TURN + HOLD * 1.6) {
          base = (base + 540) % 360;
          flipped = !flipped;
          landed = false;
          i = (i + 1) % PAIRS.length;
          t0 = now;
          set(PAIRS[i]);
          faces(PAIRS[i], flipped);
        }
      });
    });
  }

  // The hero runs at once; the scenes further down wait until the page is idle.
  story();
  function rest() {
    wallScene();
    earn();
    ledger();
    tor();
    gather();
    swap();
  }
  function idle() {
    if (window.requestIdleCallback) window.requestIdleCallback(rest, { timeout: 1200 });
    else window.setTimeout(rest, 300);
  }
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle);
})();
