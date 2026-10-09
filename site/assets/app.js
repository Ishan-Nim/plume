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
    // Only offered where it makes sense: there is nothing to reset until there
    // is an account.
    $('forgot-row').hidden = next !== 'login';
    clearNote(gateMsg);
  }

  $('tab-signup').addEventListener('click', function () { setMode('signup'); });
  $('tab-login').addEventListener('click', function () { setMode('login'); });

  // ---------- forgotten password ----------
  //
  // The answer is deliberately the same whether or not the address has an
  // account, so this says what it says regardless, and the only error it can
  // show is one about the service itself.
  // This used to post from here and report back in the sign-in card, which gave
  // a person who had just failed to sign in an error where they expected a way
  // forward. It is a page of its own now: one thing to do, room to say what
  // happens next, and somewhere to land.
  $('forgot').addEventListener('click', function () {
    var email = $('email').value.trim();
    // Carried across so nobody types their address twice. Session storage
    // rather than the URL: an address in a link ends up in history and in logs.
    if (email) {
      try { sessionStorage.setItem('plume-forgot-email', email); } catch (e) { /* private mode */ }
    }
    location.href = 'forgot.html';
  });

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

  // The vault read as its folders, the way the app reads it. A synced folder
  // puts its whole shape up here — notebooks, sub-folders, a Journal with a
  // year in it — and a flat list of paths stops being readable the moment it
  // does. Which folders are open is remembered, so deleting a document does
  // not fold everything up again.
  var openDirs = Object.create(null);

  function treeOf(files) {
    var root = { dirs: Object.create(null), order: [], files: [] };
    files.forEach(function (file) {
      var parts = String(file.path).split('/').filter(Boolean);
      var node = root;
      for (var i = 0; i < parts.length - 1; i += 1) {
        var seg = parts[i];
        if (!node.dirs[seg]) {
          node.dirs[seg] = { dirs: Object.create(null), order: [], files: [] };
          node.order.push(seg);
        }
        node = node.dirs[seg];
      }
      node.files.push(file);
    });
    return root;
  }

  function countFiles(node) {
    var total = node.files.length;
    node.order.forEach(function (name) { total += countFiles(node.dirs[name]); });
    return total;
  }

  function fileRow(file) {
    var li = document.createElement('li');

    var n = document.createElement('div');
    n.className = 'n';
    var b = document.createElement('b');
    b.textContent = file.path.split('/').pop();
    // The full name is still what identifies it.
    n.title = file.path;
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
    return li;
  }

  function paintTree(node, into, trail) {
    node.order.slice().sort().forEach(function (name) {
      var child = node.dirs[name];
      var path = trail ? trail + '/' + name : name;

      var li = document.createElement('li');
      li.className = 'dir-item';
      var box = document.createElement('details');
      box.className = 'dir';
      if (openDirs[path]) box.open = true;
      box.addEventListener('toggle', function () {
        if (box.open) openDirs[path] = true;
        else delete openDirs[path];
      });

      var sum = document.createElement('summary');
      var label = document.createElement('span');
      label.className = 'dir-name';
      label.textContent = name;
      var count = document.createElement('span');
      count.className = 'dir-count';
      count.textContent = String(countFiles(child));
      sum.appendChild(label);
      sum.appendChild(count);
      box.appendChild(sum);

      var inner = document.createElement('ul');
      inner.className = 'files';
      paintTree(child, inner, path);
      box.appendChild(inner);

      li.appendChild(box);
      into.appendChild(li);
    });

    node.files.forEach(function (file) { into.appendChild(fileRow(file)); });
  }

  function paintFiles(files) {
    state.files = files;
    var list = $('file-list');
    list.textContent = '';
    $('file-empty').hidden = files.length > 0;
    paintTree(treeOf(files), list, '');
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
