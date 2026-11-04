// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the small scenes. Each one runs on time and starts when it enters the screen;
// none reads the scroll position, so any input scrolls them the same way. With reduced motion nothing
// here starts: the HTML already holds each scene's final state.
(function () {
  'use strict';

  var K = window.Kyro;
  if (!K) return;
  var clamp = function (v, a, b) {
    return v < a ? a : v > b ? b : v;
  };
  var smooth = function (t) {
    return t * t * (3 - 2 * t);
  };
  var out = function (t) {
    return 1 - Math.pow(1 - t, 3);
  };
  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }
  function text(el, v) {
    if (el.textContent !== v) el.textContent = v;
  }
  /** Calls fn once, the first time el is well inside the screen. */
  function once(el, fn, threshold) {
    var io = new IntersectionObserver(
      function (e) {
        if (!e[e.length - 1].isIntersecting) return;
        io.disconnect();
        fn();
      },
      { threshold: threshold || 0.25 }
    );
    io.observe(el);
  }
  /** Returns a function telling whether el is on screen now. */
  function watch(el) {
    var seen = false;
    new IntersectionObserver(function (e) {
      seen = e[e.length - 1].isIntersecting;
    }).observe(el);
    return function () {
      return seen;
    };
  }

  // ---------- hero: Portfolio, Swap, Earn. The visitor picks, or it moves on slowly by itself.
  function story() {
    var el = document.querySelector('[data-story]');
    if (!el) return;
    var screens = el.querySelectorAll('[data-screen]');
    var rails = el.querySelectorAll('[data-rail]');
    var tabs = el.querySelectorAll('[data-go]');
    var current = 0, timer = 0;
    var EVERY = 6500;

    function show(i) {
      current = i;
      each(screens, function (s, n) {
        s.classList.toggle('is-on', n === i);
      });
      each(rails, function (r) {
        r.classList.toggle('on', +r.getAttribute('data-rail') === i);
      });
      each(tabs, function (b, n) {
        b.classList.toggle('on', n === i);
        b.setAttribute('aria-pressed', n === i ? 'true' : 'false');
      });
    }
    function stop() {
      window.clearInterval(timer);
      timer = 0;
    }
    function start() {
      if (timer || !K.motion) return;
      timer = window.setInterval(function () {
        show((current + 1) % screens.length);
      }, EVERY);
    }
    each(tabs, function (b, i) {
      b.addEventListener('click', function () {
        show(i);
        stop();
        start();
      });
    });
    if (!K.motion) return;

    el.querySelector('.kw-in').classList.add('draw');
    new IntersectionObserver(function (e) {
      if (e[e.length - 1].isIntersecting) start();
      else stop();
    }).observe(el);
    el.addEventListener('pointerenter', stop);
    el.addEventListener('pointerleave', start);
  }

  // ---------- Tor: the packet crosses three relays, the address goes, then it starts again calmly
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
    var OCT = ['203', '0', '113', '42'];
    var NOTES = ['Your address (example)', 'Hidden behind relay 1', 'Hidden behind relay 2', 'Hidden behind relay 3', 'A Tor exit relay'];
    var CROSS = 7000, HOLD = 2600, REST = 900;

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

    var span = 0, t0 = 0, step = -1;
    function size() {
      span = rt.offsetWidth * 0.8;
    }
    size();
    K.resize(size);
    var seen = watch(rt);

    /** Everything that changes only when the packet reaches a node. */
    function reach(n) {
      step = n;
      each(hops, function (h, i) {
        h.classList.toggle('lit', i <= n);
      });
      each(rings, function (r, i) {
        r.classList.toggle('off', n >= 3 - i); // one layer per relay
      });
      cells.forEach(function (c, i) {
        var gone = n > i;
        c.className = gone ? 'gone' : '';
        c.textContent = gone ? '•••' : OCT[i];
      });
      notes.forEach(function (s, i) {
        s.classList.toggle('on', i === n);
      });
    }
    function place(hop, o) {
      packet.style.transform = 'translate3d(' + ((hop / 4) * span).toFixed(2) + 'px,0,0)';
      packet.style.opacity = o;
      fill.style.transform = 'scaleX(' + (hop / 4).toFixed(4) + ')';
    }
    reach(0);
    place(0, 0);

    K.frame(function (y, now) {
      if (!seen()) return;
      if (!t0) t0 = now;
      var e = now - t0;
      if (e > CROSS + HOLD + REST) {
        t0 = now;
        e = 0;
        fill.style.opacity = 1;
        reach(0);
      }
      if (e > CROSS + HOLD) {
        fill.style.opacity = 0;
        return;
      }
      // It slows at each relay, and a relay counts once the packet is there.
      var u = clamp(e / CROSS, 0, 1) * 4;
      var whole = Math.floor(u);
      var hop = Math.min(4, whole + smooth(u - whole));
      place(hop, smooth(clamp(e / 500, 0, 1)) * (1 - smooth(clamp((e - CROSS - HOLD + 700) / 700, 0, 1))));
      var n = Math.floor(hop + 0.04);
      if (n !== step) reach(n);
    });
  }

  // ---------- Earn list on the page: rates count up once
  function earn() {
    var box = document.querySelector('[data-rows]');
    if (!box || !K.motion) return;
    var rows = box.querySelectorAll('.kw-earn');
    each(rows, function (r) {
      r.querySelector('[data-rate]').textContent = '0.00%';
    });
    once(
      box,
      function () {
        each(rows, function (r, i) {
          var num = r.querySelector('[data-rate]');
          var rate = +num.getAttribute('data-rate');
          var t0 = performance.now() + i * 90;
          (function tick(now) {
            var t = clamp((now - t0) / 1100, 0, 1);
            text(num, (rate * out(t)).toFixed(2) + '%');
            if (t < 1) requestAnimationFrame(tick);
          })(t0);
        });
      },
      0.2
    );
  }

  // ---------- Ledger: plays once. The wires reach the coins, the device asks, you confirm.
  function ledger() {
    var list = document.querySelectorAll('[data-ledger]');
    if (!list.length || !K.motion) return;
    each(list, function (root) {
      var owner = root.closest('[data-ledger-track]');
      var shots = root.querySelectorAll('.lg-s');
      var yes = root.querySelector('[data-lg-yes]');
      var steps = owner ? owner.querySelectorAll('.hw-steps li') : [];
      var count = owner ? owner.querySelector('[data-ledger-n]') : null;

      function screen(i) {
        each(shots, function (s, n) {
          s.style.opacity = n === i ? 1 : 0;
        });
      }
      function press(i) {
        yes.classList.remove('press');
        void root.clientWidth;
        yes.classList.add('press');
        screen(i);
      }
      function mark(i) {
        each(steps, function (li, n) {
          li.classList.toggle('on', n <= i);
        });
      }
      each(root.querySelectorAll('.lg-l'), function (l, i) {
        l.style.setProperty('--i', i);
      });
      each(root.querySelectorAll('.lg-n'), function (l, i) {
        l.style.setProperty('--i', i);
      });
      root.classList.add('wait');
      screen(0);
      mark(0);
      once(
        root,
        function () {
          root.classList.remove('wait');
          if (count) K.roll(count, 2200);
          window.setTimeout(function () {
            press(1);
            mark(1);
          }, 1700);
          window.setTimeout(function () {
            press(2);
            mark(2);
          }, 3100);
          window.setTimeout(function () {
            press(3);
          }, 4500);
        },
        0.35
      );
    });
  }

  // ---------- swap: one coin turns into the other while the amount counts
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
    each(list, function (el) {
      var spin = el.querySelector('[data-spin]');
      var front = el.querySelector('[data-f]');
      var back = el.querySelector('[data-b]');
      var a = el.querySelector('[data-a]');
      var at = el.querySelector('[data-at]');
      var b = el.querySelector('[data-bn]');
      var bt = el.querySelector('[data-bt]');
      var rate = el.querySelector('[data-rate]');
      var i = 0, t0 = 0, base = 0, flipped = false;
      var HOLD = 2200, TURN = 1400, REST = 2800;
      var seen = watch(el);

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

      set(PAIRS[0]);
      K.frame(function (y, now) {
        if (!seen()) {
          t0 = 0;
          return;
        }
        if (!t0) t0 = now;
        var pair = PAIRS[i];
        var e = now - t0;
        var k = smooth(clamp((e - HOLD) / TURN, 0, 1));
        spin.style.transform = 'rotateY(' + (base + k * 180).toFixed(2) + 'deg)';
        text(b, (pair[5] * k).toLocaleString('en-US', { minimumFractionDigits: pair[7], maximumFractionDigits: pair[7] }));
        if (e > HOLD + TURN + REST) {
          base = (base + 180) % 360;
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
  earn();
  ledger();
  tor();
  swap();
})();
