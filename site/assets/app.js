/* Plume Vault — the browser client for plume-md.com */
(function () {
  'use strict';

  var API = '/api';
  var TOKEN_KEY = 'plume-vault-token';

  var $ = function (id) { return document.getElementById(id); };

  var state = { token: null, account: null, files: [] };

  try { state.token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* private mode */ }

  // ---------- helpers ----------

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + ' d ago';
    return d.toLocaleDateString();
  }

  // Sentences built here are looked up when they are shown, in whatever
  // language the page is in; English stands in until i18n.js has its
  // dictionary. scripts/i18n-extract.js collects every quoted literal handed
  // to t() in this file, so pass one whole literal, never a variable or a sum.
  function t(text) {
    return window.plumeI18n ? window.plumeI18n.t(text) : text;
  }

  function note(el, text, kind, stay) {
    // Make the live region visible before its text changes, or screen readers
    // announce it unreliably.
    clearTimeout(el._t);
    el.className = 'msg show ' + (kind || 'err');
    el.textContent = text;
    if (kind === 'ok' && !stay) {
      el._t = setTimeout(function () { el.className = 'msg'; }, 4000);
    }
    if (!kind || kind === 'err') reveal(el);
  }

  // A message is only any use where it can be seen. The gate's sits at the top
  // of the panel, and a step can be taller than a phone's screen, so the button
  // that was pressed may be a long way below it; without this, a refusal
  // appears out of sight and the button seems to do nothing. It runs after
  // whatever the caller focuses next has scrolled itself into view, and moves
  // only as far as it must. CSS keeps it clear of the sticky header.
  function reveal(el) {
    var go = function () {
      if (/\bshow\b/.test(el.className)) el.scrollIntoView({ block: 'nearest' });
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(go);
    else setTimeout(go, 0);
  }

  function clearNote(el) {
    clearTimeout(el._t);
    el.className = 'msg';
  }

  async function api(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {});
    if (state.token) headers.Authorization = 'Bearer ' + state.token;

    var res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
    });

    if (res.status === 401 && state.token) {
      signOut();
      throw new Error('Your session expired. Sign in again.');
    }

    return res;
  }

  // Two callers, two shapes: the JSON endpoints and the raw document body.
  // Deciding by Content-Type would break the moment the vault serves a stored
  // .json document, so each call site says which it wants.
  async function apiJson(path, options) {
    var res = await api(path, options);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.ok === false) {
      var err = new Error(data.error || t('Request failed ({n}).').replace('{n}', res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function post(path, body) {
    return apiJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function apiRaw(path, options) {
    var res = await api(path, options);
    if (!res.ok) {
      var data = await res.json().catch(function () { return {}; });
      throw new Error(data.error || 'Request failed (' + res.status + ').');
    }
    return res;
  }

  // ---------- sign in / sign up ----------
  //
  // The gate shows one thing at a time: the sign-up / sign-in form, the code
  // that finishes a sign-up, the address a reset code goes to, or that code
  // with a new password. The address a code was sent to is kept here rather
  // than read back from a field, so a code is always checked against the
  // address it went to.

  var mode = 'signup';
  var gateMsg = $('gate-msg');
  var VIEWS = ['auth', 'verify', 'forgot', 'reset'];
  var pending = '';

  function show(view) {
    VIEWS.forEach(function (name) { $(name + '-form').hidden = name !== view; });
    // Switching tabs halfway through a code would leave that code nowhere to go.
    $('tabs').hidden = view !== 'auth';
    if (view !== 'verify' && view !== 'reset') stopResend();
    clearNote(gateMsg);
  }

  function paintSubmit() {
    $('auth-submit').textContent = mode === 'signup' ? t('Create my vault') : t('Sign in');
  }

  function setMode(next) {
    mode = next;
    $('tab-signup').setAttribute('aria-pressed', String(next === 'signup'));
    $('tab-login').setAttribute('aria-pressed', String(next === 'login'));
    paintSubmit();
    $('password').setAttribute('autocomplete', next === 'signup' ? 'new-password' : 'current-password');
    $('pw-hint').hidden = next !== 'signup';
    // Only offered where it makes sense: there is nothing to reset until there
    // is an account.
    $('forgot-row').hidden = next !== 'login';
    show('auth');
  }

  $('tab-signup').addEventListener('click', function () { setMode('signup'); });
  $('tab-login').addEventListener('click', function () { setMode('login'); });

  // Every way in ends here: a sign-in, a finished sign-up, a reset by code.
  async function signedIn(data, message, stay) {
    state.token = data.token;
    state.account = data.account;
    try { localStorage.setItem(TOKEN_KEY, data.token); } catch (e) { /* ignore */ }
    forgetGate();
    await showVault();
    if (message) note($('acct-msg'), message, 'ok', stay);
  }

  // Nothing typed into the gate outlives it: not a password, not a code.
  function forgetGate() {
    ['password', 'verify-code', 'reset-code', 'reset-password', 'reset-username'].forEach(function (id) {
      $(id).value = '';
    });
    pending = '';
    setMode(mode);
  }

  function looksLikeEmail(text) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  }

  $('auth-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('auth-submit');
    var email = $('email').value.trim();
    var password = $('password').value;

    if (!email || !password) {
      note(gateMsg, t('Fill in both fields.'));
      return;
    }

    btn.disabled = true;
    btn.textContent = mode === 'signup' ? t('Sending a code…') : t('Signing in…');
    clearNote(gateMsg);

    try {
      if (mode === 'signup') {
        // Nothing is created yet. The answer is the same whether or not the
        // address already has a vault — that one gets an email saying so
        // instead of a code — so the next step is the same either way.
        var started = await post('/auth/signup/start', { email: email, password: password });
        askForCode('verify', email, started.minutes);
      } else {
        await signedIn(await post('/auth/login', { email: email, password: password }));
      }
    } catch (err) {
      note(gateMsg, t(err.message));
    } finally {
      btn.disabled = false;
      paintSubmit();
    }
  });

  // ---------- the code from the email ----------

  function askForCode(view, email, minutes) {
    pending = email;
    show(view);
    $(view + '-email').textContent = email;
    $(view + '-code').value = '';

    if (view === 'verify') {
      var ttl = $('verify-ttl');
      ttl.textContent = minutes ? t('The code works for {n} minutes.').replace('{n}', minutes) : '';
      ttl.hidden = !minutes;
    } else {
      $('reset-username').value = email;
      $('reset-password').value = '';
    }

    holdResend($(view + '-resend'));
    $(view + '-code').focus();
  }

  // Digits only, however they arrive: typed on a full-width keyboard, pasted
  // with the space or dash a mail client put in the middle, or filled in by
  // the browser from the message.
  function digits(text) {
    return String(text || '')
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/\D/g, '')
      .slice(0, 6);
  }

  function submitForm(form) {
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  ['verify', 'reset'].forEach(function (view) {
    var input = $(view + '-code');

    function tidy() {
      var clean = digits(input.value);
      if (clean !== input.value) input.value = clean;
      // A whole sign-up code is the whole step, so it goes straight in. A reset
      // still needs the new password, so that one waits for the button.
      if (view === 'verify' && clean.length === 6 && !$('verify-submit').disabled) {
        submitForm($('verify-form'));
      }
    }

    // maxlength would cut "123 456" to "123 45" before anything could tidy
    // it, so a paste is taken in whole and cleaned here instead.
    input.addEventListener('paste', function (ev) {
      var text = ev.clipboardData && ev.clipboardData.getData('text');
      if (!text) return;
      ev.preventDefault();
      input.value = digits(text);
      tidy();
    });
    input.addEventListener('input', function (ev) {
      if (!ev.isComposing) tidy();
    });
    input.addEventListener('compositionend', tidy);
  });

  // A new code replaces the one before it, and the server will not send
  // another inside a minute anyway, so the button sits that minute out where
  // it can be seen.
  var RESEND_WAIT = 60 * 1000;
  var resendTimer = null;

  function holdResend(btn) {
    clearInterval(resendTimer);
    var until = Date.now() + RESEND_WAIT;
    var tick = function () {
      // Counted from the clock, not the ticks: a background tab runs timers late.
      var left = Math.ceil((until - Date.now()) / 1000);
      if (left > 0) {
        btn.disabled = true;
        btn.textContent = t('Resend code in {n} s').replace('{n}', left);
        return;
      }
      clearInterval(resendTimer);
      resendTimer = null;
      btn.disabled = false;
      btn.textContent = t('Resend code');
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  function stopResend() {
    clearInterval(resendTimer);
    resendTimer = null;
    ['verify-resend', 'reset-resend'].forEach(function (id) {
      $(id).disabled = false;
      $(id).textContent = t('Resend code');
    });
  }

  async function resend(view, path, body) {
    holdResend($(view + '-resend'));
    $(view + '-code').focus();
    try {
      await post(path, body);
      note(gateMsg, t('A new code is on its way. Use the newest one.'), 'ok');
      reveal(gateMsg);
    } catch (err) {
      note(gateMsg, t(err.message));
    }
  }

  // ---------- creating an account: the code ----------

  $('verify-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('verify-submit');
    if (btn.disabled) return;
    var code = digits($('verify-code').value);
    if (code.length !== 6) {
      note(gateMsg, t('Enter the 6-digit code from the email.'));
      $('verify-code').focus();
      return;
    }

    btn.disabled = true;
    btn.textContent = t('Checking…');
    clearNote(gateMsg);

    try {
      // The password goes with the code. The vault is created with the one
      // sent here, not with whatever was sent when the code was asked for, so
      // a code that reaches this mailbox makes this person's vault, whoever
      // else may have typed the address in meanwhile.
      var verified = await post('/auth/signup/verify', {
        email: pending, code: code, password: $('password').value,
      });
      await signedIn(verified, t('Your vault is ready.'));
    } catch (err) {
      if (err.status === 409) {
        // The address got a vault while this code was on its way — most
        // likely from another tab. Signing in is all that is left to do.
        var email = pending;
        setMode('login');
        $('email').value = email;
        note(gateMsg, t(err.message));
        $('password').focus();
        return;
      }
      note(gateMsg, t(err.message));
      $('verify-code').select();
    } finally {
      btn.disabled = false;
      btn.textContent = t('Finish creating my vault');
    }
  });

  // The password is still in the hidden form: a new code is a new sign-up
  // request, and the server checks the password again before sending one.
  $('verify-resend').addEventListener('click', function () {
    resend('verify', '/auth/signup/start', { email: pending, password: $('password').value });
  });

  $('verify-back').addEventListener('click', function () {
    setMode('signup');
    $('email').focus();
    $('email').select();
  });

  // ---------- forgotten password ----------
  //
  // The answers are deliberately the same whether or not the address has an
  // account, so the steps are too: the code step appears either way, and the
  // only errors it can show are about the request or the service itself.

  $('forgot').addEventListener('click', function () {
    show('forgot');
    $('forgot-email').value = $('email').value.trim();
    $('forgot-email').focus();
  });

  $('forgot-back').addEventListener('click', function () {
    setMode('login');
    $('email').focus();
  });

  $('forgot-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('forgot-submit');
    var email = $('forgot-email').value.trim();

    // The server answers a mistyped address exactly like a real one, so this
    // is the only place a typo can be caught before someone waits for a code
    // that is never coming.
    if (!looksLikeEmail(email)) {
      note(gateMsg, email ? t('That email address does not look right.') : t('Type your email address.'));
      $('forgot-email').focus();
      return;
    }

    btn.disabled = true;
    btn.textContent = t('Sending…');
    clearNote(gateMsg);

    try {
      await post('/auth/forgot', { email: email });
      $('email').value = email;
      askForCode('reset', email);
    } catch (err) {
      note(gateMsg, t(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = t('Email me a code');
    }
  });

  $('reset-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('reset-submit');
    var code = digits($('reset-code').value);
    var password = $('reset-password').value;

    if (code.length !== 6) {
      note(gateMsg, t('Enter the 6-digit code from the email.'));
      $('reset-code').focus();
      return;
    }
    if (!password) {
      note(gateMsg, t('Type a new password.'));
      $('reset-password').focus();
      return;
    }

    btn.disabled = true;
    btn.textContent = t('Setting your password…');
    clearNote(gateMsg);

    try {
      // The server checks the password before it spends the code, so a
      // password that is too short costs nothing but a second try.
      var data = await post('/auth/reset/code', { email: pending, code: code, password: password });
      // Kept on screen: being signed out everywhere else is worth reading.
      await signedIn(data, data.note ? t(data.note) : t('Your password is set.'), true);
    } catch (err) {
      note(gateMsg, t(err.message));
      // The cursor where the fix goes. The server checks the password before
      // the code, so a refusal that is not about the code is about the password.
      if (/\bcode\b/i.test(err.message)) $('reset-code').select();
      else $('reset-password').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = t('Set my password');
    }
  });

  $('reset-resend').addEventListener('click', function () {
    resend('reset', '/auth/forgot', { email: pending });
  });

  $('reset-back').addEventListener('click', function () {
    var email = pending;
    show('forgot');
    $('forgot-email').value = email;
    $('forgot-email').focus();
    $('forgot-email').select();
  });

  // Hiding the panel is not forgetting it: the email, the file list and the
  // last opened document would otherwise still be in the DOM for whoever sits
  // down next, and would flash on screen during the next sign-in.
  function clearVaultUi() {
    ['v-email', 'v-plan', 'v-used', 'v-files'].forEach(function (id) {
      $(id).textContent = '—';
    });
    $('v-bar').style.width = '0%';
    $('file-list').textContent = '';
    $('file-empty').hidden = true;
    $('viewer-name').textContent = '—';
    $('viewer-body').textContent = '';
    viewer.classList.remove('show');
    clearNote(vaultMsg);
    clearNote($('acct-msg'));

    $('tok-list').textContent = '';
    $('tok-empty').hidden = true;
    $('tok-reveal').classList.remove('show');
    $('tok-value').textContent = '';
    clearNote(tokMsg);

    if (graph) graph.setData([], []);
    $('graph-legend').textContent = '';
    $('graph-tip').classList.remove('show');
    $('graph-empty').textContent = 'Loading your graph…';
    $('graph-empty').hidden = false;
  }

  function signOut() {
    state.token = null;
    state.account = null;
    state.files = [];
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    clearVaultUi();
    $('vault').hidden = true;
    $('gate').hidden = false;
    $('signout').hidden = true;
    document.title = 'Plume Vault — sign in';
  }

  $('signout').addEventListener('click', signOut);

  // ---------- the vault ----------

  var vaultMsg = $('vault-msg');

  function paintAccount(account) {
    state.account = account;
    $('v-email').textContent = account.email;
    $('v-plan').textContent = account.planName + ' · member since ' + new Date(account.createdAt).toLocaleDateString();
    var pct = account.quotaBytes > 0 ? Math.min(100, (account.usedBytes / account.quotaBytes) * 100) : 0;
    $('v-bar').style.width = pct.toFixed(1) + '%';
    $('v-used').textContent = bytes(account.usedBytes) + ' of ' + bytes(account.quotaBytes) + ' used';
    $('v-files').textContent = account.fileCount + (account.fileCount === 1 ? ' document' : ' documents');
  }

  function paintFiles(files) {
    state.files = files;
    var list = $('file-list');
    list.textContent = '';
    $('file-empty').hidden = files.length > 0;

    files.forEach(function (file) {
      var li = document.createElement('li');

      var n = document.createElement('div');
      n.className = 'n';
      var b = document.createElement('b');
      b.textContent = file.path;
      var s = document.createElement('span');
      s.textContent = bytes(file.size) + ' · updated ' + when(file.updatedAt);
      n.appendChild(b);
      n.appendChild(s);

      var acts = document.createElement('div');
      acts.className = 'acts';

      var view = document.createElement('button');
      view.type = 'button';
      view.className = 'btn btn-ghost btn-sm';
      view.textContent = 'Open';
      view.addEventListener('click', function () { openFile(file); });

      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-ghost btn-sm';
      save.textContent = 'Save';
      save.addEventListener('click', function () { downloadFile(file); });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-ghost btn-sm';
      del.textContent = 'Delete';
      del.addEventListener('click', function () { removeFile(file); });

      acts.appendChild(view);
      acts.appendChild(save);
      acts.appendChild(del);
      li.appendChild(n);
      li.appendChild(acts);
      list.appendChild(li);
    });
  }

  async function refresh() {
    var data = await apiJson('/vault/list');
    paintAccount(data.account);
    paintFiles(data.files);
    loadGraph();
    loadTokens();
  }

  // ---------- API tokens ----------

  var tokMsg = $('tok-msg');

  function paintTokens(list) {
    var ul = $('tok-list');
    ul.textContent = '';
    $('tok-empty').hidden = list.length > 0;

    list.forEach(function (token) {
      var li = document.createElement('li');

      var t = document.createElement('div');
      t.className = 't';
      var name = document.createElement('b');
      name.textContent = token.name;
      var meta = document.createElement('span');
      meta.textContent = token.hint + ' · created ' + when(token.createdAt);
      t.appendChild(name);
      t.appendChild(meta);

      var revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'btn btn-ghost btn-sm';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async function () {
        if (!window.confirm('Revoke "' + token.name + '"? Anything using it stops working straight away.')) return;
        try {
          var data = await apiJson('/tokens?id=' + encodeURIComponent(token.id), { method: 'DELETE' });
          paintTokens(data.tokens);
          note(tokMsg, 'Token revoked.', 'ok');
        } catch (err) {
          note(tokMsg, err.message);
        }
      });

      li.appendChild(t);
      li.appendChild(revoke);
      ul.appendChild(li);
    });
  }

  async function loadTokens() {
    try {
      var data = await apiJson('/tokens');
      paintTokens(data.tokens);
    } catch (err) {
      note(tokMsg, err.message);
    }
  }

  $('tok-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var name = $('tok-name').value.trim();
    try {
      var data = await apiJson('/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || 'Untitled token' }),
      });
      // Shown once, and only here: the server keeps nothing but its hash.
      $('tok-value').textContent = data.token;
      $('tok-reveal').classList.add('show');
      $('tok-name').value = '';
      await loadTokens();
    } catch (err) {
      note(tokMsg, err.message);
    }
  });

  $('tok-copy').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText($('tok-value').textContent);
      note(tokMsg, 'Token copied to the clipboard.', 'ok');
    } catch (err) {
      note(tokMsg, 'Could not copy — select the token and copy it by hand.');
    }
  });

  $('tok-done').addEventListener('click', function () {
    $('tok-reveal').classList.remove('show');
    $('tok-value').textContent = '';
  });

  // ---------- the graph ----------

  var graph = null;
  var graphTip = null;

  function describe(node) {
    return node.name + ' · ' + (node.links === 1 ? '1 link' : node.links + ' links');
  }

  function paintLegend(folders) {
    var legend = $('graph-legend');
    legend.textContent = '';
    if (!folders || folders.length < 2) return;

    folders.slice(0, 8).forEach(function (folder, i) {
      var item = document.createElement('span');
      var dot = document.createElement('i');
      dot.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:99px;margin-right:6px;'
        + 'background:hsl(' + [262, 190, 36, 150, 320, 12, 212, 96][i % 8] + ' 62% 58%)';
      var label = document.createElement('b');
      label.textContent = folder === '' ? 'Top level' : folder;
      item.appendChild(dot);
      item.appendChild(label);
      legend.appendChild(item);
    });
  }

  async function loadGraph() {
    var canvas = $('graph-canvas');
    var empty = $('graph-empty');
    if (!canvas || !window.PlumeGraph) return;

    var data;
    try {
      data = await apiJson('/vault/graph');
    } catch (err) {
      empty.textContent = err.message;
      empty.hidden = false;
      return;
    }

    if (!data.nodes.length) {
      empty.textContent = 'Sync some documents and the links between them appear here.';
      empty.hidden = false;
      if (graph) graph.setData([], []);
      paintLegend([]);
      return;
    }
    empty.hidden = true;

    if (!graph) {
      graphTip = $('graph-tip');
      graph = new window.PlumeGraph(canvas, {
        onHover: function (node) {
          if (!node) {
            graphTip.classList.remove('show');
            return;
          }
          graphTip.textContent = '';
          var name = document.createElement('b');
          name.textContent = node.path;
          var meta = document.createElement('span');
          meta.textContent = describe(node) + ' · ' + bytes(node.size)
            + (node.updatedAt ? ' · ' + when(node.updatedAt) : '');
          graphTip.appendChild(name);
          graphTip.appendChild(meta);
          graphTip.classList.add('show');
        },
        onOpen: function (node) {
          var file = state.files.filter(function (f) { return f.path === node.path; })[0];
          if (file) openFile(file);
        },
      });

      window.addEventListener('resize', function () { graph.resize(); });
      $('graph-fit').addEventListener('click', function () { graph.fit(); });
      $('graph-shake').addEventListener('click', function () { graph.nudge(); });
    }

    graph.setData(data.nodes, data.edges);
    graph.resize();
    paintLegend(graph.folders);
    setTimeout(function () { if (graph) graph.fit(); }, 900);
  }

  async function showVault() {
    clearVaultUi();
    $('gate').hidden = true;
    $('vault').hidden = false;
    $('signout').hidden = false;
    document.title = 'Plume Vault';
    try {
      await refresh();
    } catch (err) {
      note(state.token ? vaultMsg : gateMsg, err.message);
    }
  }

  $('refresh').addEventListener('click', async function () {
    try {
      await refresh();
      note(vaultMsg, 'Up to date.', 'ok');
    } catch (err) {
      note(vaultMsg, err.message);
    }
  });

  // ---------- open / download / delete ----------

  var viewer = $('viewer');

  async function openFile(file) {
    try {
      var res = await apiRaw('/vault/file?path=' + encodeURIComponent(file.path));
      var blob = await res.blob();
      if (/\.(png|jpe?g|gif|webp|avif)$/i.test(file.path)) {
        downloadBlob(blob, file.path);
        return;
      }
      $('viewer-name').textContent = file.path;
      $('viewer-body').textContent = await blob.text();
      viewer.classList.add('show');
      viewer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      note(vaultMsg, err.message);
    }
  }

  $('viewer-close').addEventListener('click', function () {
    viewer.classList.remove('show');
    $('viewer-body').textContent = '';
  });

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function downloadFile(file) {
    try {
      var res = await apiRaw('/vault/file?path=' + encodeURIComponent(file.path));
      downloadBlob(await res.blob(), file.path);
    } catch (err) {
      note(vaultMsg, err.message);
    }
  }

  async function removeFile(file) {
    if (!window.confirm('Delete "' + file.path + '" from your vault? This cannot be undone.')) return;
    try {
      var data = await apiJson('/vault/file?path=' + encodeURIComponent(file.path), { method: 'DELETE' });
      paintAccount(data.account);
      await refresh();
      note(vaultMsg, 'Deleted.', 'ok');
    } catch (err) {
      note(vaultMsg, err.message);
    }
  }

  // ---------- uploading ----------

  async function upload(files) {
    var done = 0;
    var failed = [];

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      try {
        var buf = await file.arrayBuffer();
        await apiJson('/vault/file?path=' + encodeURIComponent(file.name), {
          method: 'PUT',
          body: buf,
        });
        done += 1;
      } catch (err) {
        failed.push(file.name + ' — ' + err.message);
      }
    }

    try { await refresh(); } catch (e) { /* the message below still applies */ }

    if (failed.length) {
      note(vaultMsg, failed.join('  ·  '));
    } else {
      note(vaultMsg, done + (done === 1 ? ' file added.' : ' files added.'), 'ok');
    }
  }

  var drop = $('drop');
  var input = $('file-input');

  $('pick').addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () {
    if (input.files.length) upload(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (evt) {
    drop.addEventListener(evt, function (ev) {
      ev.preventDefault();
      drop.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    drop.addEventListener(evt, function (ev) {
      ev.preventDefault();
      drop.classList.remove('over');
    });
  });
  drop.addEventListener('drop', function (ev) {
    if (ev.dataTransfer && ev.dataTransfer.files.length) upload(ev.dataTransfer.files);
  });

  // ---------- start ----------

  setMode('signup');
  if (state.token) {
    showVault();
  }
})();
