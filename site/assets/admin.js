/* Plume Vault — admin overview, for plume-md.com/admin.html */
(function () {
  'use strict';

  var API = '/api';
  var TOKEN_KEY = 'plume-vault-token';

  var $ = function (id) { return document.getElementById(id); };

  var state = { token: null, email: null };

  try { state.token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* private mode */ }

  // ---------- helpers ----------
  // Same shape as assets/app.js's: kept separate because each page's script
  // is meant to stand alone, not share an internal module.

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + ' d ago';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function note(el, text, kind) {
    el.className = 'msg show ' + (kind || 'err');
    el.textContent = text;
  }

  function clearNote(el) { el.className = 'msg'; el.textContent = ''; }

  async function api(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {});
    if (state.token) headers.Authorization = 'Bearer ' + state.token;

    var res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
    });
    return res;
  }

  async function apiJson(path, options) {
    var res = await api(path, options);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.ok === false) {
      var err = new Error(data.error || 'Request failed (' + res.status + ').');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function cell(tag, text, className) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    return el;
  }

  // ---------- sign in ----------

  var gateMsg = $('gate-msg');
  var gateNote = $('gate-note');

  function forgetSession() {
    state.token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  function showGate(noteText) {
    $('dash').hidden = true;
    $('gate').hidden = false;
    $('signout').hidden = !state.token;
    clearNote(gateMsg);
    if (noteText) {
      note(gateNote, noteText, 'note');
    } else {
      clearNote(gateNote);
    }
    document.title = 'Plume Vault — admin';
  }

  $('auth-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('auth-submit');
    var email = $('email').value.trim();
    var password = $('password').value;

    if (!email || !password) {
      note(gateMsg, 'Fill in both fields.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    clearNote(gateMsg);

    try {
      var data = await apiJson('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      });
      state.token = data.token;
      try { localStorage.setItem(TOKEN_KEY, data.token); } catch (e) { /* ignore */ }
      $('password').value = '';
      await enter();
    } catch (err) {
      note(gateMsg, err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('signout').addEventListener('click', function () {
    forgetSession();
    showGate();
  });

  // ---------- painting the dashboard ----------

  var dashMsg = $('dash-msg');

  var HIST_LABELS = [
    ['empty', 'Empty'],
    ['under1MB', 'Under 1 MB'],
    ['from1to10MB', '1–10 MB'],
    ['from10to50MB', '10–50 MB'],
    ['over50MB', 'Over 50 MB'],
  ];

  function paintHistogram(histogram) {
    var wrap = $('hist');
    clearChildren(wrap);
    var max = Math.max(1, Math.max.apply(null, HIST_LABELS.map(function (p) { return histogram[p[0]] || 0; })));

    HIST_LABELS.forEach(function (pair) {
      var count = histogram[pair[0]] || 0;
      var row = document.createElement('div');
      row.className = 'hist-row';

      var bar = document.createElement('div');
      bar.className = 'hist-bar';
      var fill = document.createElement('i');
      fill.style.width = Math.round((count / max) * 100) + '%';
      bar.appendChild(fill);

      row.appendChild(cell('span', pair[1], 'k'));
      row.appendChild(bar);
      row.appendChild(cell('span', String(count), 'n'));
      wrap.appendChild(row);
    });
  }

  function paintTable(bodyId, emptyId, rows) {
    var body = $(bodyId);
    clearChildren(body);
    $(emptyId).hidden = rows.length > 0;

    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.appendChild(cell('td', r.email, 'email'));
      tr.appendChild(cell('td', String(r.documents), 'num'));
      tr.appendChild(cell('td', bytes(r.bytes), 'num'));
      tr.appendChild(cell('td', when(r.createdAt)));
      tr.appendChild(cell('td', when(r.lastActiveAt)));
      body.appendChild(tr);
    });
  }

  function healthItem(label, value) {
    var item = document.createElement('div');
    item.className = 'health-item';
    item.appendChild(cell('div', label, 'k'));
    var v = document.createElement('div');
    v.className = 'v';
    v.appendChild(value);
    item.appendChild(v);
    return item;
  }

  function textNode(text) { return document.createTextNode(text); }

  function paintHealth(health) {
    var grid = $('health-grid');
    clearChildren(grid);

    var storageValue = document.createElement('span');
    var dot = document.createElement('i');
    dot.className = 'dot ' + (health.storage.ok ? 'ok' : 'bad');
    storageValue.appendChild(dot);
    storageValue.appendChild(textNode(health.storage.ok ? 'Reachable' : ('Unreachable — ' + (health.storage.error || ''))));
    grid.appendChild(healthItem('Storage', storageValue));

    grid.appendChild(healthItem('Bucket', textNode(health.storage.bucket + ' (' + health.storage.region + ')')));

    var uptime = health.uptimeSeconds || 0;
    var h = Math.floor(uptime / 3600);
    var m = Math.floor((uptime % 3600) / 60);
    grid.appendChild(healthItem('Uptime', textNode(h + 'h ' + m + 'm')));

    grid.appendChild(healthItem('Memory (RSS)', textNode(bytes(health.memory.rssBytes))));
    grid.appendChild(healthItem('Memory (heap)', textNode(bytes(health.memory.heapUsedBytes))));
    grid.appendChild(healthItem('Node', textNode(health.node)));

    var adminValue = document.createElement('span');
    var adminDot = document.createElement('i');
    adminDot.className = 'dot ' + (health.adminConfigured ? 'ok' : 'bad');
    adminValue.appendChild(adminDot);
    adminValue.appendChild(textNode(health.adminConfigured ? 'Configured' : 'Not configured'));
    grid.appendChild(healthItem('ADMIN_EMAILS', adminValue));
  }

  function paintOverview(data) {
    $('t-accounts').textContent = String(data.accounts.total);
    $('t-accounts-sub').textContent =
      '+' + data.accounts.last1 + ' today · +' + data.accounts.last7 + ' this week · +' + data.accounts.last30 + ' this month';

    $('t-documents').textContent = String(data.documents.total);
    $('t-documents-sub').textContent = data.vaults.withDocuments + ' of ' + data.accounts.total + ' vaults have a document';

    $('t-storage').textContent = bytes(data.documents.bytes);
    $('t-storage-sub').textContent = data.accounts.total ? (bytes(data.documents.bytes / Math.max(1, data.accounts.total)) + ' average per account') : '—';

    $('t-downloads').textContent = String(data.downloads.total);
    var platforms = Object.keys(data.downloads.byPlatform || {});
    $('t-downloads-sub').textContent = platforms.length
      ? platforms.map(function (p) { return p + ' ' + data.downloads.byPlatform[p]; }).join(' · ')
      : 'no platform data yet';

    $('t-tokens').textContent = String(data.tokens.total);

    paintHistogram(data.vaults.histogram);
    paintTable('top-body', 'top-empty', data.top);
    paintTable('recent-body', 'recent-empty', data.recent);

    $('updated').textContent = 'Updated ' + when(data.generatedAt);
  }

  // ---------- loading ----------

  async function load() {
    try {
      var overview = await apiJson('/admin/overview');
      var health = await apiJson('/admin/health');
      paintOverview(overview);
      paintHealth(health);
      clearNote(dashMsg);
    } catch (err) {
      note(dashMsg, err.message);
    }
  }

  async function enter() {
    if (!state.token) {
      showGate();
      return;
    }
    try {
      var overview = await apiJson('/admin/overview');
      var health = await apiJson('/admin/health');

      $('gate').hidden = true;
      $('dash').hidden = false;
      $('signout').hidden = false;
      document.title = 'Plume Vault — admin';

      var email = '';
      try { email = JSON.parse(atob(state.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || ''; } catch (e) { /* ignore */ }
      $('who-email').textContent = email || 'this account';

      paintOverview(overview);
      paintHealth(health);
      clearNote(dashMsg);
    } catch (err) {
      if (err.status === 401) {
        forgetSession();
        showGate();
        return;
      }
      if (err.status === 403) {
        // Deliberately the same plain message whether this account simply
        // is not an admin, or is an admin that signed in with a personal
        // access token rather than a password — the page must never say
        // which, or it becomes a way to check who is on the allow-list.
        showGate('This account cannot see the admin view.');
        return;
      }
      showGate();
      note(gateMsg, err.message);
    }
  }

  $('refresh').addEventListener('click', async function () {
    var btn = $('refresh');
    btn.disabled = true;
    await load();
    btn.disabled = false;
  });

  // The vaults counter was bumped when an account was created, so the number
  // on the home page was a count of sign-ups. The counting is fixed; this
  // corrects a number that was already stored, by counting what is there.
  $('recount').addEventListener('click', async function () {
    var btn = $('recount');
    btn.disabled = true;
    try {
      var data = await apiJson('/admin/recount-vaults', { method: 'POST' });
      note(dashMsg, 'Vaults: ' + data.before + ' \u2192 ' + data.vaults + '.', 'ok');
      await load();
    } catch (err) {
      note(dashMsg, err.message);
    }
    btn.disabled = false;
  });

  // ---------- start ----------

  enter();
})();
