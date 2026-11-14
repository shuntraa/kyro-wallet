// SPDX-License-Identifier: GPL-3.0-or-later
// Admin mailer page. Talks only to /api/admin/* on this same site.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var views = { login: $('view-login'), compose: $('view-compose') };
  var logoutBtn = $('logout');
  var senders = [];
  var requestId = newId();

  function newId() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  }

  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    logoutBtn.hidden = name !== 'compose';
  }

  function api(path, method, body) {
    var opts = { method: method || 'GET', credentials: 'same-origin', cache: 'no-store' };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function setMsg(el, text, ok) {
    el.textContent = text || '';
    el.classList.toggle('ok', !!ok);
  }

  // ---------- senders
  function selectedSender() {
    var r = document.querySelector('input[name="from"]:checked');
    for (var i = 0; i < senders.length; i++) if (r && senders[i].id === r.value) return senders[i];
    return senders[0];
  }

  function updateHint() {
    var s = selectedSender();
    $('sign-hint').textContent = s ? 'Envoi depuis ' + s.address + '. Signature ajoutée à l’envoi : « ' + s.team + ' ».' : '';
  }

  function renderSenders(list) {
    senders = list;
    var box = $('senders');
    box.textContent = '';
    list.forEach(function (s, i) {
      var label = document.createElement('label');
      label.className = 'adm-sender';
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'from';
      input.value = s.id;
      input.checked = i === 0;
      var card = document.createElement('span');
      card.className = 'adm-sender-box';
      var name = document.createElement('span');
      name.className = 'adm-sender-name';
      name.textContent = s.id.charAt(0).toUpperCase() + s.id.slice(1);
      card.appendChild(name);
      label.appendChild(input);
      label.appendChild(card);
      input.addEventListener('change', updateHint);
      box.appendChild(label);
    });
    updateHint();
  }

  // ---------- session
  function loadSession(message) {
    return api('/api/admin/session').then(function (r) {
      if (r.ok && r.data && r.data.senders) {
        if (!senders.length) renderSenders(r.data.senders);
        show('compose');
      } else {
        show('login');
        setMsg($('login-msg'), message || '');
      }
    }).catch(function () {
      show('login');
      setMsg($('login-msg'), 'Connexion impossible. Réessaie.');
    }).then(function () {
      document.body.classList.add('adm-ready');
    });
  }

  // ---------- login
  // The password field is a plain type="password" that is never swapped to text, and it keeps its value until the
  // login form is hidden, so the phone's password manager recognises it and offers to save it.

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('login-btn');
    var user = $('user').value.trim();
    var pass = $('password').value;
    if (!user || !pass) { setMsg($('login-msg'), 'Remplis les deux champs.'); return; }
    btn.disabled = true;
    setMsg($('login-msg'), '');
    api('/api/admin/login', 'POST', { user: user, password: pass }).then(function (r) {
      if (r.ok) return loadSession();
      setMsg($('login-msg'), (r.data && r.data.error) || 'Erreur. Réessaie.');
    }).catch(function () {
      setMsg($('login-msg'), 'Connexion impossible. Réessaie.');
    }).then(function () { btn.disabled = false; });
  });

  logoutBtn.addEventListener('click', function () {
    api('/api/admin/logout', 'POST', {}).then(function () {
      $('to').value = ''; $('subject').value = ''; $('body').value = '';
      $('login-form').reset();
      setMsg($('send-msg'), '');
      setMsg($('login-msg'), '');
      show('login');
    });
  });

  // ---------- send
  $('compose-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('send-btn');
    var msg = $('send-msg');
    var s = selectedSender();
    var to = $('to').value.trim();
    var subject = $('subject').value.trim();
    var body = $('body').value.trim();
    if (!to || !subject || !body) { setMsg(msg, 'Destinataire, objet et message sont obligatoires.'); return; }

    btn.disabled = true;
    btn.textContent = 'Envoi…';
    setMsg(msg, '');
    api('/api/admin/send', 'POST', { from: s.id, to: to, subject: subject, body: body, requestId: requestId }).then(function (r) {
      if (r.ok) {
        setMsg(msg, 'Envoyé à ' + (r.data.to || [to]).join(', ') + ' depuis ' + s.address + '.', true);
        $('to').value = ''; $('subject').value = ''; $('body').value = '';
        requestId = newId();
      } else if (r.status === 401) {
        show('login');
        setMsg($('login-msg'), 'Session expirée. Reconnecte-toi, ton message est gardé.');
      } else {
        setMsg(msg, (r.data && r.data.error) || 'Échec de l’envoi.');
      }
    }).catch(function () {
      setMsg(msg, 'Connexion impossible. Le message n’est pas parti.');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Envoyer';
    });
  });

  loadSession();
})();
