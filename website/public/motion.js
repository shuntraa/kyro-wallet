// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the one frame loop and the smooth-scroll driver, scroll reveals, redaction bars,
// magnetic buttons, the cursor light on cards and the small-screen menu. Motion is off for
// reduced motion.
(function () {
  'use strict';

  var root = document.documentElement;
  var motion = root.classList.contains('js');
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var header = document.querySelector('.site-header');
  var bar = document.querySelector('[data-progress]');

  /** Exponential damping against real time: the same feel at 60, 144 or 240 Hz, and it cannot overshoot. */
  function damp(a, b, tau, dt) {
    return b + (a - b) * Math.exp(-dt / tau);
  }

  // One frame loop for the whole site. Everyone reads K.y, the eased position, never scrollY.
  var jobs = [];
  var K = (window.Kyro = {
    motion: motion,
    fine: fine,
    damp: damp,
    y: window.scrollY,
    v: 0, // eased speed, px per second
    dt: 1 / 60,
    frame: function (fn) {
      jobs.push(fn);
    },
    scrollTo: function (y) {
      if (wheel) wheel.to(y);
      else window.scrollTo(0, y);
    }
  });

  // A phone's address bar changes innerHeight while scrolling. K.vh is the small viewport height,
  // which does not move, and K.resize only reports real resizes: nothing re-measures mid-swipe.
  var probe = document.createElement('div');
  probe.className = 'vh-probe';
  document.body.appendChild(probe);
  function readVh() {
    K.vh = probe.offsetHeight || window.innerHeight;
  }
  readVh();
  var coarse = window.matchMedia('(pointer: coarse)').matches;
  var resizers = [], lastW = window.innerWidth, lastH = window.innerHeight;
  K.coarse = coarse;
  K.resize = function (fn) {
    resizers.push(fn);
  };
  window.addEventListener('resize', function () {
    var w = window.innerWidth, h = window.innerHeight;
    if (w === lastW && (coarse || h === lastH)) return;
    lastW = w;
    lastH = h;
    readVh();
    for (var i = 0; i < resizers.length; i++) resizers[i]();
  });

  var maxY = 0;
  function measure() {
    maxY = root.scrollHeight - window.innerHeight;
  }
  measure();
  K.resize(measure);
  window.addEventListener('load', measure);
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.body);

  // A notched wheel feeds a target and the loop eases towards it. Only notches are taken: trackpads,
  // touch, keyboard, the scrollbar and anchors stay native, and the target follows them.
  var wheel = null;
  if (motion && fine) {
    wheel = (function () {
      var TAU = 0.105;
      var target = window.scrollY, pos = target, active = false, freeUntil = 0;
      function notched(e) {
        if (e.deltaMode !== 0) return true;
        var w = Math.abs(e.wheelDeltaY || 0);
        return w >= 120 && w % 120 === 0;
      }
      function nestedScroll(el, dy) {
        for (; el && el !== document.body && el.nodeType === 1; el = el.parentNode) {
          if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
            if ((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) || (dy < 0 && el.scrollTop > 0)) return true;
          }
        }
        return false;
      }
      function stop() {
        active = false;
      }
      window.addEventListener(
        'wheel',
        function (e) {
          if (e.ctrlKey || e.metaKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || nestedScroll(e.target, e.deltaY)) return;
          var now = e.timeStamp;
          // A trackpad stream stays native until it has been quiet for a moment.
          if (!notched(e)) {
            freeUntil = now + 250;
            stop();
            return;
          }
          if (now < freeUntil) return;
          e.preventDefault();
          if (!active) target = pos = window.scrollY;
          var unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? window.innerHeight : 1;
          target = Math.max(0, Math.min(maxY, target + e.deltaY * unit));
          active = true;
        },
        { passive: false }
      );
      window.addEventListener('keydown', stop);
      window.addEventListener('touchstart', stop, { passive: true });
      window.addEventListener('pointerdown', function (e) {
        if (e.target === root) stop(); // the scrollbar
      });
      window.addEventListener('hashchange', stop);
      return {
        tick: function (dt) {
          if (!active) return false;
          pos = damp(pos, target, TAU, dt);
          if (Math.abs(target - pos) < 0.3) {
            pos = target;
            active = false;
          }
          window.scrollTo(0, pos);
          return active;
        },
        pos: function () {
          return pos;
        },
        to: function (y) {
          if (!active) pos = window.scrollY;
          target = Math.max(0, Math.min(maxY, y));
          active = true;
        }
      };
    })();
  }

  var last = 0, barY = -1, shrunk = false;
  function loop(now) {
    requestAnimationFrame(loop);
    var raw = now - last;
    last = now;
    var dt = raw > 0 ? Math.min(raw / 1000, 0.05) : 1 / 60;
    K.dt = dt;
    K.raw = raw;
    var moving = wheel ? wheel.tick(dt) : false;
    // Wheel: pos is already eased and unrounded. Anything native gets the same kind of ease here.
    var y = moving ? wheel.pos() : window.scrollY;
    var prev = K.y;
    K.y = moving ? y : damp(K.y, y, coarse ? 0.09 : 0.07, dt);
    if (Math.abs(K.y - y) < 0.05) K.y = y;
    K.v = damp(K.v, (K.y - prev) / dt, 0.18, dt);
    // Two thresholds: a notch around either one never flips the bar.
    if (header) {
      if (!shrunk && K.y > 140) {
        shrunk = true;
        header.classList.add('scrolled');
      } else if (shrunk && K.y < 30) {
        shrunk = false;
        header.classList.remove('scrolled');
      }
    }
    if (bar && K.y !== barY) {
      barY = K.y;
      bar.style.transform = 'scaleX(' + (maxY > 0 ? Math.min(K.y / maxY, 1) : 0).toFixed(4) + ')';
    }
    for (var i = 0; i < jobs.length; i++) jobs[i](K.y, now, dt);
  }

  /** Rolls the number inside el up from zero, keeping its prefix, suffix and decimals. */
  function roll(el, ms) {
    var full = el.textContent;
    var m = /[\d,]*\.?\d+/.exec(full);
    if (!m || !motion) return;
    var target = parseFloat(m[0].replace(/,/g, ''));
    var dec = (m[0].split('.')[1] || '').length;
    var head = full.slice(0, m.index), tail = full.slice(m.index + m[0].length);
    var t0 = performance.now();
    (function tick(now) {
      var t = Math.min(1, (now - t0) / (ms || 1300));
      var k = 1 - Math.pow(1 - t, 4);
      el.textContent = t < 1 ? head + (target * k).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + tail : full;
      if (t < 1) requestAnimationFrame(tick);
    })(t0);
  }
  K.roll = roll;

  function reveals() {
    var groups = document.querySelectorAll('[data-reveal-group]');
    for (var g = 0; g < groups.length; g++) {
      for (var k = 0; k < groups[g].children.length; k++) {
        var kid = groups[g].children[k];
        kid.setAttribute('data-reveal', '');
        kid.style.transitionDelay = Math.min(k * 70, 500) + 'ms';
      }
    }
    var rows = document.querySelectorAll('[data-rows] .kw-earn');
    for (var r = 0; r < rows.length; r++) rows[r].style.setProperty('--i', r);

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var el = e.target;
          el.classList.add('in');
          io.unobserve(el);
          if (el.hasAttribute('data-roll')) roll(el);
          // Hover transitions must not wait for the entrance delay.
          if (el.style.transitionDelay) {
            window.setTimeout(function () {
              el.style.transitionDelay = '';
            }, 1500);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    var fees = document.querySelectorAll('.fee-value');
    for (var f = 0; f < fees.length; f++) if (!fees[f].querySelector('[data-roll]')) fees[f].setAttribute('data-roll', '');
    var items = document.querySelectorAll('[data-reveal], [data-roll], h2 .rd');
    for (var j = 0; j < items.length; j++) io.observe(items[j]);
    window.addEventListener('beforeprint', function () {
      for (var p = 0; p < items.length; p++) items[p].classList.add('in');
    });
  }

  function magnets() {
    var list = document.querySelectorAll('.magnet');
    Array.prototype.forEach.call(list, function (el) {
      var raf = 0, dx = 0, dy = 0;
      function paint() {
        raf = 0;
        el.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)';
      }
      el.addEventListener('pointermove', function (e) {
        var b = el.getBoundingClientRect();
        dx = (e.clientX - b.left - b.width / 2) * 0.22;
        dy = (e.clientY - b.top - b.height / 2) * 0.32;
        el.style.transition = 'transform .12s linear, background .25s, color .25s, border-color .25s, box-shadow .35s';
        if (!raf) raf = requestAnimationFrame(paint);
      });
      el.addEventListener('pointerleave', function () {
        el.style.transition = 'transform .7s cubic-bezier(.2,1.6,.35,1), background .25s, color .25s, border-color .25s, box-shadow .35s';
        el.style.transform = '';
      });
    });
  }

  function cursor() {
    var light = document.querySelector('.cursor-light');
    var x = 0, y = 0, cx = 0, cy = 0, seen = false;
    document.addEventListener(
      'pointermove',
      function (e) {
        x = e.clientX;
        y = e.clientY;
        if (!seen) {
          seen = true;
          cx = x;
          cy = y;
          if (light) light.classList.add('on');
        }
        var card = e.target.closest ? e.target.closest('.spot') : null;
        if (!card) return;
        var b = card.getBoundingClientRect();
        card.style.setProperty('--mx', (x - b.left).toFixed(0) + 'px');
        card.style.setProperty('--my', (y - b.top).toFixed(0) + 'px');
        if (card.classList.contains('tilt')) {
          var rx = ((y - b.top) / b.height - 0.5) * -7;
          var ry = ((x - b.left) / b.width - 0.5) * 7;
          card.style.transform = 'perspective(900px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg) translateY(-4px)';
        }
      },
      { passive: true }
    );
    K.frame(function (sy, now, dt) {
      if (!seen || !light) return;
      cx = damp(cx, x, 0.09, dt);
      cy = damp(cy, y, 0.09, dt);
      light.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0)';
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tilt'), function (el) {
      el.addEventListener('pointerleave', function () {
        el.style.transform = '';
      });
    });
  }

  /** One light that glides between the links. Sizes are read when it moves, never per frame. */
  function navLight() {
    var list = document.querySelector('.nav ul');
    if (!list) return;
    var ind = document.createElement('li');
    ind.className = 'nav-ind';
    ind.setAttribute('aria-hidden', 'true');
    list.appendChild(ind);
    var here = null, hover = null;
    function place() {
      var a = hover || here;
      ind.style.opacity = a ? 1 : 0;
      if (!a) return;
      ind.style.width = a.offsetWidth + 'px';
      ind.style.transform = 'translate3d(' + a.offsetLeft + 'px,0,0)';
    }
    function current(a) {
      if (here === a) return;
      if (here) here.classList.remove('here');
      here = a;
      if (a) a.classList.add('here');
      place();
    }
    Array.prototype.forEach.call(list.querySelectorAll('a'), function (a) {
      a.addEventListener('pointerenter', function () {
        hover = a;
        place();
      });
      a.addEventListener('pointerleave', function () {
        hover = null;
        place();
      });
    });
    current(list.querySelector('[aria-current]'));
    K.resize(place);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);

    // Home page: the light follows the section. It only changes once the middle of the screen is
    // well inside the next section, so a notch back and forth on a boundary changes nothing.
    var els = document.querySelectorAll('[data-nav], [data-nonav]');
    if (!els.length) return;
    var zones = [], cur = -1, EDGE = 90;
    function measureZones() {
      var y = window.scrollY;
      zones = Array.prototype.map.call(els, function (el) {
        var b = el.getBoundingClientRect();
        var href = el.getAttribute('data-nav');
        return { top: b.top + y, bottom: b.bottom + y, link: href ? list.querySelector('a[href="' + href + '"]') : null };
      });
    }
    measureZones();
    K.resize(measureZones);
    window.addEventListener('load', measureZones);
    if (window.ResizeObserver) new ResizeObserver(measureZones).observe(document.body);
    K.frame(function (y) {
      var c = y + K.vh * 0.5;
      if (cur >= 0 && c >= zones[cur].top - EDGE && c < zones[cur].bottom + EDGE) return;
      for (var i = 0; i < zones.length; i++) {
        if (c >= zones[i].top + (i > cur ? EDGE : 0) && c < zones[i].bottom - (i < cur ? EDGE : 0)) {
          cur = i;
          current(zones[i].link);
          return;
        }
      }
    });
  }

  /** Touch has no hover: a tap on a redacted word closes it for a moment. */
  function taps() {
    document.addEventListener('click', function (e) {
      var w = e.target.closest ? e.target.closest('h2 .rd.in') : null;
      if (!w) return;
      w.classList.add('re');
      window.setTimeout(function () {
        w.classList.remove('re');
      }, 900);
    });
  }

  function menu() {
    var m = document.querySelector('.menu');
    if (!m) return;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && m.open) {
        m.open = false;
        m.querySelector('summary').focus();
      }
    });
    document.addEventListener('click', function (e) {
      if (m.open && (!m.contains(e.target) || e.target.closest('a'))) m.open = false;
    });
  }

  // /#support is a closed answer in the FAQ: open it when the link points at it.
  function hashOpen() {
    var id = window.location.hash.slice(1);
    var el = id && document.getElementById(id);
    if (el && el.tagName === 'DETAILS') {
      el.open = true;
      el.scrollIntoView();
    }
  }

  menu();
  navLight();
  hashOpen();
  window.addEventListener('hashchange', hashOpen);

  if (motion) {
    reveals();
    if (!fine) taps();
    if (fine) {
      magnets();
      cursor();
    }
  }
  requestAnimationFrame(loop);
})();
