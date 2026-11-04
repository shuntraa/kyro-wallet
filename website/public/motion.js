// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the one frame loop, the reveals, the cursor light on cards and the small-screen
// menu. Scrolling is native everywhere. Every animation runs on time, started once when its element
// enters, so a notched wheel and a finger look the same. Motion is off for reduced motion.
(function () {
  'use strict';

  var root = document.documentElement;
  var motion = root.classList.contains('js');
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /** Exponential damping against real time: the same feel at 60, 144 or 240 Hz, and it cannot overshoot. */
  function damp(a, b, tau, dt) {
    return b + (a - b) * Math.exp(-dt / tau);
  }

  // One frame loop for the whole site. K.y is a heavily eased scroll value, only for the silk's drift.
  var jobs = [];
  var K = (window.Kyro = {
    motion: motion,
    fine: fine,
    damp: damp,
    y: window.scrollY,
    frame: function (fn) {
      jobs.push(fn);
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

  var last = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    var raw = now - last;
    last = now;
    var dt = raw > 0 ? Math.min(raw / 1000, 0.05) : 1 / 60;
    K.raw = raw;
    K.y = damp(K.y, window.scrollY, 0.7, dt);
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

  /** Tags what should rise in: section heads and group children stagger, a lone heading gets its own. */
  function reveals() {
    function stagger(list, step) {
      for (var k = 0; k < list.length; k++) {
        list[k].setAttribute('data-reveal', '');
        list[k].style.transitionDelay = Math.min(k * step, 480) + 'ms';
      }
    }
    var heads = document.querySelectorAll('.head-center');
    for (var h = 0; h < heads.length; h++) stagger(heads[h].children, 90);
    var groups = document.querySelectorAll('[data-reveal-group]');
    for (var g = 0; g < groups.length; g++) stagger(groups[g].children, 80);
    var titles = document.querySelectorAll('main h2');
    for (var t = 0; t < titles.length; t++) {
      if (!titles[t].closest('[data-reveal]')) titles[t].setAttribute('data-reveal', '');
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
            }, 1400);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    var fees = document.querySelectorAll('.fee-value');
    for (var f = 0; f < fees.length; f++) if (!fees[f].querySelector('[data-roll]')) fees[f].setAttribute('data-roll', '');
    var items = document.querySelectorAll('[data-reveal], [data-roll]');
    for (var j = 0; j < items.length; j++) io.observe(items[j]);
    window.addEventListener('beforeprint', function () {
      for (var p = 0; p < items.length; p++) items[p].classList.add('in');
    });
  }

  /** The soft light that follows the pointer inside a card. */
  function spotlight() {
    document.addEventListener(
      'pointermove',
      function (e) {
        var card = e.target.closest ? e.target.closest('.spot') : null;
        if (!card) return;
        var b = card.getBoundingClientRect();
        card.style.setProperty('--mx', (e.clientX - b.left).toFixed(0) + 'px');
        card.style.setProperty('--my', (e.clientY - b.top).toFixed(0) + 'px');
      },
      { passive: true }
    );
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
  hashOpen();
  window.addEventListener('hashchange', hashOpen);

  if (motion) {
    reveals();
    if (fine) spotlight();
  }
  requestAnimationFrame(loop);
})();
