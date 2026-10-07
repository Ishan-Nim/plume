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

  function note(el, text, kind) {
    // Make the live region visible before its text changes, or screen readers
    // announce it unreliably.
    el.className = 'msg show ' + (kind || 'err');
    el.textContent = text;
    if (kind === 'ok') {
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.className = 'msg'; }, 4000);
    }
  }

  function clearNote(el) { el.className = 'msg'; }

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
      throw new Error(data.error || 'Request failed (' + res.status + ').');
    }
    return data;
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

  var mode = 'signup';
  var gateMsg = $('gate-msg');

  function setMode(next) {
    mode = next;
    $('tab-signup').setAttribute('aria-pressed', String(next === 'signup'));
    $('tab-login').setAttribute('aria-pressed', String(next === 'login'));
    $('auth-submit').textContent = next === 'signup' ? 'Create my vault' : 'Sign in';
    $('password').setAttribute('autocomplete', next === 'signup' ? 'new-password' : 'current-password');
    $('pw-hint').hidden = next !== 'signup';
    clearNote(gateMsg);
  }

  $('tab-signup').addEventListener('click', function () { setMode('signup'); });
  $('tab-login').addEventListener('click', function () { setMode('login'); });

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
    btn.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…';
    clearNote(gateMsg);

    try {
      var data = await apiJson('/auth/' + (mode === 'signup' ? 'signup' : 'login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      });
      state.token = data.token;
      state.account = data.account;
      try { localStorage.setItem(TOKEN_KEY, data.token); } catch (e) { /* ignore */ }
      $('password').value = '';
      await showVault();
    } catch (err) {
      note(gateMsg, err.message);
    } finally {
      btn.disabled = false;
      setMode(mode);
    }
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
