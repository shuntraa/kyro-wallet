// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the scroll scenes. The hero window, the Tor route, the coin field and the swap
// coin. Transforms and opacity only, run from the frame loop in motion.js. With reduced motion
// nothing here starts: the HTML already holds each scene's final state.
(function () {
  'use strict';

  var K = window.Kyro;
  var clamp = function (v, a, b) {
    return v < a ? a : v > b ? b : v;
  };
  var lerp = function (a, b, t) {
    return a + (b - a) * t;
  };
  var seg = function (p, a, b) {
    return clamp((p - a) / (b - a), 0, 1);
  };
  var ease = function (t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  var out = function (t) {
    return 1 - Math.pow(1 - t, 3);
  };
  var money = function (n) {
    return Math.round(n).toLocaleString('en-US');
  };

  // Track geometry is measured on resize, never inside a frame.
  var tracks = [];
  function track(el) {
    var t = { el: el, top: 0, h: 0 };
    tracks.push(t);
    measure(t);
    return t;
  }
  function measure(t) {
    var b = t.el.getBoundingClientRect();
    t.top = b.top + window.scrollY;
    t.h = b.height;
  }
  function remeasure() {
    tracks.forEach(measure);
  }
  window.addEventListener('resize', remeasure);
  window.addEventListener('load', remeasure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);
  if (window.ResizeObserver) new ResizeObserver(remeasure).observe(document.body);

  /** 0 when the track's top reaches the viewport top, 1 when its bottom reaches the viewport bottom. */
  function pinned(t, y) {
    return clamp((y - t.top) / Math.max(1, t.h - window.innerHeight), 0, 1);
  }
  /** 0 when the track enters the viewport, 1 when it leaves. For scenes that do not pin. */
  function passing(t, y) {
    var vh = window.innerHeight;
    return clamp((y + vh - t.top) / (vh + t.h), 0, 1);
  }
  function near(t, y) {
    return y + window.innerHeight + 200 > t.top && y < t.top + t.h + 200;
  }
  function text(el, v) {
    if (el.textContent !== v) el.textContent = v;
  }

  // ---------- hero: the window, its screens and the story under it
  function story() {
    var el = document.querySelector('[data-story]');
    if (!el) return;
    var wrap = el.querySelector('[data-kw]');
    var copy = el.querySelector('[data-copy]');
    var ui = el.querySelector('[data-ui]');
    var cap = el.querySelector('[data-caption]');
    var screens = el.querySelectorAll('[data-screen]');
    var rails = el.querySelectorAll('[data-rail]');
    var dots = el.querySelectorAll('[data-go]');
    var balance = el.querySelector('[data-balance]');
    var from = el.querySelector('[data-sw-from]');
    var to = el.querySelector('[data-sw-to]');
    var caps = ['Every coin on one screen', 'Any coin to any coin, fee in the rate', 'Rates side by side'];
    var current = -1;
    var tr = track(el);

    function show(i) {
      if (i === current) return;
      current = i;
      for (var r = 0; r < rails.length; r++) rails[r].classList.toggle('on', +rails[r].getAttribute('data-rail') === i);
      for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('on', d === i);
      if (cap) cap.textContent = caps[i];
    }
    function setScreen(i, opacity, x) {
      var s = screens[i];
      s.style.opacity = opacity;
      s.style.visibility = opacity > 0.01 ? 'visible' : 'hidden';
      s.style.transform = x ? 'translate3d(' + x.toFixed(1) + 'px,0,0)' : '';
    }
    function count(target, ms) {
      var t0 = performance.now();
      (function tick(now) {
        var t = clamp((now - t0) / ms, 0, 1);
        balance.textContent = money(lerp(target * 0.62, target, out(t)));
        if (t < 1) requestAnimationFrame(tick);
      })(t0);
    }

    if (!K || !K.motion) {
      // Reduced motion: no cycling, the buttons switch screens.
      Array.prototype.forEach.call(dots, function (b, i) {
        b.addEventListener('click', function () {
          for (var s = 0; s < screens.length; s++) screens[s].classList.toggle('is-on', s === i);
          show(i);
        });
      });
      show(0);
      return;
    }

    var kw = el.querySelector('.kw-in');
    kw.classList.add('draw');
    count(12345, 1800);

    var wide = window.matchMedia('(min-width: 1100px) and (min-height: 640px)');
    var wrapW = 1;
    // Screen boundaries on the pinned track.
    var EDGES = [0.16, 0.46, 0.74];
    var X = 0.03;

    function pinnedFrame(y) {
      if (!near(tr, y)) return;
      var p = pinned(tr, y);
      var t = ease(seg(p, 0, 0.17));
      var vw = window.innerWidth;
      wrap.style.transform =
        'translate3d(' + (lerp(0.245, 0, t) * vw).toFixed(1) + 'px,' + lerp(34, 0, t).toFixed(1) + 'px,0)' +
        ' rotateY(' + lerp(-20, 0, t).toFixed(2) + 'deg) rotateX(' + lerp(7, 0, t).toFixed(2) + 'deg) rotateZ(' + lerp(1.2, 0, t).toFixed(2) + 'deg)' +
        ' scale(' + lerp(0.66, 1, t).toFixed(4) + ')';
      copy.style.opacity = (1 - seg(p, 0.015, 0.1)).toFixed(3);
      copy.style.transform = 'translate3d(' + (-seg(p, 0, 0.12) * 90).toFixed(1) + 'px,0,0)';
      copy.style.visibility = p > 0.11 ? 'hidden' : 'visible';
      var live = p > 0.13;
      ui.style.opacity = seg(p, 0.12, 0.17).toFixed(3);
      ui.classList.toggle('live', live);

      var a = seg(p, EDGES[1] - X, EDGES[1] + X);
      var b = seg(p, EDGES[2] - X, EDGES[2] + X);
      var w = wrapW * 0.06;
      setScreen(0, 1 - a, -a * w);
      setScreen(1, a * (1 - b), (1 - a) * w - b * w);
      setScreen(2, b, (1 - b) * w);
      show(b > 0.5 ? 2 : a > 0.5 ? 1 : 0);

      // The swap fills in as you scroll through it.
      var s = out(seg(p, EDGES[1], EDGES[1] + 0.14));
      text(from, lerp(0, 1, s).toFixed(4));
      text(to, lerp(0, 100, s).toFixed(2));
    }

    // Small screens: no pin. The window sits in the page and cycles by itself.
    var timer = 0, idx = 0;
    function cycleTo(i) {
      idx = i;
      for (var s = 0; s < screens.length; s++) setScreen(s, s === i ? 1 : 0, 0);
      show(i);
    }
    function startCycle() {
      if (timer) return;
      timer = window.setInterval(function () {
        if (!document.hidden && near(tr, window.scrollY)) cycleTo((idx + 1) % screens.length);
      }, 4800);
    }
    function stopCycle() {
      window.clearInterval(timer);
      timer = 0;
    }

    function layout() {
      wrapW = wrap.offsetWidth;
      if (wide.matches) {
        stopCycle();
      } else {
        wrap.style.transform = '';
        copy.style.cssText = '';
        ui.style.opacity = '';
        cycleTo(idx);
        startCycle();
      }
    }
    window.addEventListener('resize', layout);
    layout();
    show(0);

    Array.prototype.forEach.call(dots, function (btn, i) {
      btn.addEventListener('click', function () {
        if (wide.matches) {
          var stops = [0.3, 0.6, 0.88];
          K.scrollTo(tr.top + stops[i] * (tr.h - window.innerHeight));
        } else {
          stopCycle();
          cycleTo(i);
        }
      });
    });

    K.frame(function (y) {
      if (wide.matches) pinnedFrame(y);
    });
  }

  // ---------- Tor: the packet crosses three relays and the address disappears
  function tor() {
    var el = document.querySelector('[data-tor]');
    if (!el || !K || !K.motion) return;
    var ip = el.querySelector('[data-ip]');
    var note = el.querySelector('[data-ip-note]');
    var packet = el.querySelector('[data-packet]');
    var fill = el.querySelector('[data-rt-fill]');
    var rings = packet.querySelectorAll('i');
    var hops = el.querySelectorAll('[data-hop]');
    var rt = el.querySelector('.rt');
    var pin = window.matchMedia('(min-width: 900px) and (min-height: 640px)');
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
    var lastNote = -1, lastFrame = 0, span = 0;
    var tr = track(el);
    function size() {
      span = rt.offsetWidth * 0.8;
    }
    size();
    window.addEventListener('resize', size);

    K.frame(function (y, now) {
      if (!near(tr, y)) return;
      var p = pin.matches ? pinned(tr, y) : clamp((passing(tr, y) - 0.25) / 0.45, 0, 1);
      var t = seg(p, 0.06, 0.92); // 0 at Kyro, 1 at the network
      packet.style.transform = 'translate3d(' + (t * span).toFixed(1) + 'px,0,0)';
      packet.style.opacity = (seg(p, 0, 0.05) * (1 - seg(p, 0.95, 1))).toFixed(3);
      fill.style.transform = 'scaleX(' + t.toFixed(4) + ')';

      var hop = t * 4; // 0, 1, 2, 3, 4 at the five nodes
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
        } else if (cell.className) {
          cell.className = '';
          cell.textContent = OCT[c];
        } else if (cell.textContent !== OCT[c]) {
          cell.textContent = OCT[c];
        }
      }
      var n = Math.min(4, Math.floor(hop + 0.1));
      if (n !== lastNote) {
        lastNote = n;
        note.textContent = NOTES[n];
      }
    });
  }

  // ---------- coin field: every coin drifts in depth, then they form the Kyro mark
  function gather() {
    var el = document.querySelector('[data-gather]');
    if (!el || !K || !K.motion) return;
    var coins = el.querySelectorAll('.fc');
    var mark = el.querySelector('[data-mark]');
    var cta = el.querySelector('[data-cta]');
    var word = el.querySelector('.wordmark');
    var pinBox = el.querySelector('.gather-pin');
    var N = coins.length;
    var CENTER = 9; // a 3 x 3 block makes the square in the mark
    var mx = 0, my = 0, tx = 0, ty = 0;
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
      items = [];
      for (var i = 0; i < N; i++) {
        var gx, gy, end;
        if (i < arc) {
          // Two staggered lanes along the open ring (from 40 to 320 degrees).
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
          spin: (((i * 53) % 40) - 20),
          delay: ((i * 13) % N) / N
        });
      }
    }
    build();
    window.addEventListener('resize', build);
    if (K.fine) {
      window.addEventListener(
        'pointermove',
        function (e) {
          tx = e.clientX / window.innerWidth - 0.5;
          ty = e.clientY / window.innerHeight - 0.5;
        },
        { passive: true }
      );
    }

    K.frame(function (y, now) {
      if (!near(tr, y)) return;
      var p = pinned(tr, y);
      mx += (tx - mx) * 0.06;
      my += (ty - my) * 0.06;
      var time = now / 1000;
      var fade = seg(p, 0.66, 0.74); // coins hand over to the solid mark
      var vis = seg(p, 0, 0.08);
      for (var i = 0; i < N; i++) {
        var c = items[i];
        var g = ease(clamp((p - 0.08 - c.delay * 0.2) / 0.34, 0, 1));
        var depth = (c.z + 0.25) * (1 - g);
        var x = lerp(c.sx + Math.sin(time * 0.5 + c.ph) * 16 * depth - mx * 150 * depth, c.gx, g);
        var yy = lerp(c.sy + Math.cos(time * 0.42 + c.ph) * 16 * depth - my * 110 * depth + (0.5 - p) * 320 * depth, c.gy, g) - 30;
        var s = lerp(c.base, c.end, g);
        c.el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + yy.toFixed(1) + 'px,0) rotate(' + ((1 - g) * c.spin).toFixed(1) + 'deg) scale(' + s.toFixed(3) + ')';
        c.el.style.opacity = (vis * lerp(lerp(0.4, 1, c.z), 1, g) * (1 - fade)).toFixed(3);
      }
      // The mark appears on the coins, at the centre of the frame, then moves up to make room.
      var rise = ease(seg(p, 0.72, 0.88));
      var ctaIn = out(seg(p, 0.78, 0.96));
      var big = (unit * 64) / markBase;
      mark.style.opacity = fade.toFixed(3);
      mark.style.transform = 'translate3d(0,' + ((H / 2 - 30 - markY) * (1 - rise)).toFixed(1) + 'px,0) scale(' + lerp(big, 1, rise).toFixed(3) + ')';
      cta.style.opacity = ctaIn.toFixed(3);
      cta.style.transform = 'translate3d(0,' + ((1 - ctaIn) * 40).toFixed(1) + 'px,0)';
      cta.style.pointerEvents = ctaIn > 0.5 ? '' : 'none';
      word.style.opacity = ctaIn.toFixed(3);
      word.style.transform = 'translate3d(-50%,' + ((1 - ctaIn) * 90).toFixed(1) + 'px,0)';
    });
  }

  // ---------- swap: one coin turns into the other while the amounts count
  function swap() {
    var list = document.querySelectorAll('[data-swap]');
    if (!list.length || !K || !K.motion) return;
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
      var i = 0, seen = false, t0 = 0, angle = 0, base = 0;
      var HOLD = 1500, TURN = 1500;

      function set(pair) {
        a.textContent = pair[2].toLocaleString('en-US', { minimumFractionDigits: pair[6], maximumFractionDigits: pair[6] });
        at.textContent = pair[1];
        bt.textContent = pair[4];
        var r = pair[5] / pair[2];
        rate.textContent = '1 ' + pair[1] + ' ≈ ' + (r >= 1 ? Math.round(r).toLocaleString('en-US') : r.toFixed(4)) + ' ' + pair[4];
      }
      function faces(pair, flipped) {
        // The hidden face is the one to change: it is swapped while it cannot be seen.
        (flipped ? front : back).src = '/img/coins/' + pair[3] + '.svg';
        (flipped ? back : front).src = '/img/coins/' + pair[0] + '.svg';
      }
      new IntersectionObserver(function (e) {
        seen = e[e.length - 1].isIntersecting;
      }).observe(el);

      var flipped = false;
      set(PAIRS[0]);
      K.frame(function (y, now) {
        if (!seen) {
          t0 = 0;
          return;
        }
        if (!t0) t0 = now;
        var pair = PAIRS[i];
        var e = now - t0;
        var t = clamp((e - HOLD) / TURN, 0, 1);
        var k = ease(t);
        // Three half turns: quick spin, the coin ends on its other face.
        angle = base + k * 540;
        spin.style.transform = 'rotateY(' + angle.toFixed(2) + 'deg) scale(' + (1 + Math.sin(t * Math.PI) * 0.14).toFixed(3) + ')';
        var shown = (pair[5] * k).toLocaleString('en-US', { minimumFractionDigits: pair[7], maximumFractionDigits: pair[7] });
        text(b, shown);
        if (e > HOLD + TURN + HOLD * 1.6) {
          base = (base + 540) % 360;
          flipped = !flipped;
          i = (i + 1) % PAIRS.length;
          t0 = now;
          set(PAIRS[i]);
          faces(PAIRS[i], flipped);
        }
      });
    });
  }

  story();
  tor();
  gather();
  swap();
})();
