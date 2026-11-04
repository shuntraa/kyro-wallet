// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: inertial wheel scrolling, scroll reveals, word by word titles, magnetic buttons,
// the cursor light on cards, and the small-screen menu. All of it off for reduced motion.
(function () {
  'use strict';

  var root = document.documentElement;
  var motion = root.classList.contains('js');
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var header = document.querySelector('.site-header');
  var bar = document.querySelector('[data-progress]');

  // One frame loop for the whole site. scenes.js adds its work with Kyro.frame(fn).
  var jobs = [];
  var K = (window.Kyro = {
    motion: motion,
    fine: fine,
    velocity: 0,
    frame: function (fn) {
      jobs.push(fn);
    },
    scrollTo: function (y) {
      if (smooth) smooth.to(y);
      else window.scrollTo(0, y);
    }
  });

  // Wheel input eases towards its target. Keyboard, scrollbar, touch and anchors stay native:
  // the target simply follows the real position whenever the wheel is idle.
  var smooth = null;
  if (motion && fine) {
    smooth = (function () {
      var target = window.scrollY, pos = target, active = false;
      function max() {
        return root.scrollHeight - window.innerHeight;
      }
      function scrollable(el, dy) {
        for (; el && el !== document.body && el.nodeType === 1; el = el.parentNode) {
          if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
            if ((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) || (dy < 0 && el.scrollTop > 0)) return true;
          }
        }
        return false;
      }
      window.addEventListener(
        'wheel',
        function (e) {
          if (e.ctrlKey || e.metaKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || scrollable(e.target, e.deltaY)) return;
          e.preventDefault();
          if (!active) target = pos = window.scrollY;
          var unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? window.innerHeight : 1;
          target = Math.max(0, Math.min(max(), target + e.deltaY * unit));
          active = true;
        },
        { passive: false }
      );
      return {
        tick: function () {
          if (!active) return;
          pos += (target - pos) * 0.11;
          if (Math.abs(target - pos) < 0.4) {
            pos = target;
            active = false;
          }
          window.scrollTo(0, pos);
        },
        to: function (y) {
          if (!active) pos = window.scrollY;
          target = Math.max(0, Math.min(max(), y));
          active = true;
        }
      };
    })();
  }

  var lastY = window.scrollY, marquees = [], barY = -1;
  function loop(now) {
    requestAnimationFrame(loop);
    if (smooth) smooth.tick();
    var y = window.scrollY;
    K.velocity += (y - lastY - K.velocity) * 0.2;
    lastY = y;
    if (header) header.classList.toggle('scrolled', y > 40);
    if (bar) {
      var range = root.scrollHeight - window.innerHeight;
      if (y !== barY) {
        barY = y;
        bar.style.transform = 'scaleX(' + (range > 0 ? Math.min(y / range, 1) : 0).toFixed(4) + ')';
      }
    }
    for (var i = 0; i < jobs.length; i++) jobs[i](y, now);
    // The coin rows run faster while the page moves.
    if (marquees.length) {
      var rate = 1 + Math.min(Math.abs(K.velocity) * 0.09, 5);
      for (var m = 0; m < marquees.length; m++) marquees[m].updatePlaybackRate(rate);
    }
  }

  function words(el) {
    var n = 0;
    (function walk(node) {
      var kids = Array.prototype.slice.call(node.childNodes);
      kids.forEach(function (kid) {
        if (kid.nodeType === 1) return walk(kid);
        if (kid.nodeType !== 3 || !kid.nodeValue.trim()) return;
        var frag = document.createDocumentFragment();
        kid.nodeValue.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) return frag.appendChild(document.createTextNode(' '));
          var outer = document.createElement('span');
          var inner = document.createElement('span');
          outer.className = 'wd';
          inner.textContent = part;
          inner.style.setProperty('--i', n++);
          outer.appendChild(inner);
          frag.appendChild(outer);
        });
        node.replaceChild(frag, kid);
      });
    })(el);
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
    var titles = document.querySelectorAll('[data-words]');
    for (var t = 0; t < titles.length; t++) words(titles[t]);

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
    var items = document.querySelectorAll('[data-reveal], [data-words], [data-roll]');
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
    var x = 0, y = 0, cx = 0, cy = 0, seen = false, card = null, ex = 0, ey = 0;
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
        ex = x;
        ey = y;
        card = e.target.closest ? e.target.closest('.spot') : null;
      },
      { passive: true }
    );
    K.frame(function () {
      if (!seen) return;
      cx += (x - cx) * 0.14;
      cy += (y - cy) * 0.14;
      if (light) light.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0)';
      if (card) {
        var b = card.getBoundingClientRect();
        card.style.setProperty('--mx', (ex - b.left).toFixed(0) + 'px');
        card.style.setProperty('--my', (ey - b.top).toFixed(0) + 'px');
        if (card.classList.contains('tilt')) {
          var rx = ((ey - b.top) / b.height - 0.5) * -7;
          var ry = ((ex - b.left) / b.width - 0.5) * 7;
          card.style.transform = 'perspective(900px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg) translateY(-4px)';
        }
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tilt'), function (el) {
      el.addEventListener('pointerleave', function () {
        el.style.transform = '';
      });
    });
  }

  function navLight() {
    var list = document.querySelector('.nav ul');
    if (!list) return;
    var ind = document.createElement('li');
    ind.className = 'nav-ind';
    ind.setAttribute('aria-hidden', 'true');
    list.appendChild(ind);
    var links = list.querySelectorAll('a');
    var here = null, hover = null;
    function place() {
      var a = hover || here;
      ind.style.opacity = a ? 1 : 0;
      if (!a) return;
      ind.style.width = a.offsetWidth + 'px';
      ind.style.height = a.offsetHeight + 'px';
      ind.style.transform = 'translate3d(' + a.offsetLeft + 'px,' + a.offsetTop + 'px,0)';
    }
    function current(a) {
      if (here === a) return;
      if (here) here.classList.remove('here');
      here = a;
      if (a) a.classList.add('here');
      place();
    }
    Array.prototype.forEach.call(links, function (a) {
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
    window.addEventListener('resize', place);
    // The pill changes size when it shrinks: keep the light on its link.
    if (header) header.addEventListener('transitionend', place);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
    var zones = document.querySelectorAll('[data-nav]');
    if (!zones.length || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          e.target.__in = e.isIntersecting;
        });
        var on = null;
        for (var i = 0; i < zones.length; i++) if (zones[i].__in) on = zones[i];
        current(on ? list.querySelector('a[href="' + on.getAttribute('data-nav') + '"]') : null);
      },
      { rootMargin: '-50% 0px -50% 0px' }
    );
    for (var z = 0; z < zones.length; z++) io.observe(zones[z]);
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
    if (fine) {
      magnets();
      cursor();
    }
    Array.prototype.forEach.call(document.querySelectorAll('.mq-row'), function (row) {
      var a = row.getAnimations && row.getAnimations()[0];
      if (a && a.updatePlaybackRate) marquees.push(a);
    });
  }
  requestAnimationFrame(loop);
})();
