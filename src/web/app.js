// Plume on the web: the vault in a browser tab.
//
// The same documents the desktop app reads, rendered by the same pipeline —
// markdown.js and enhance.js are imported from the renderer rather than copied,
// so a note looks the same here as it does in the app, and a change to how
// Markdown renders reaches both at once.
//
// What this is not: a second implementation of Plume. There is no file system
// here, so there are no loose folders and no local-only vaults. The web view
// only ever shows what is already in your account, which is the subset of your
// notes you chose to link a vault for.

import DOMPurify from 'dompurify';
import { createMarkdown, splitWiki, wikiLabel } from '../renderer/markdown.js';
import { enhance, assignHeadingIds, plainText } from '../renderer/enhance.js';

const api = '/api';
const $ = sel => document.querySelector(sel);

const state = {
  token: null,
  account: null,
  files: [],          // every document in the account, newest listing
  vault: null,        // the vault whose tree is on screen
  doc: null,          // { path, text, dirty }
  editing: false,
  query: '',
};

let md = null;
const markdown = () => (md || (md = createMarkdown({ breaks: true })));

// ---------------------------------------------------------------------------
// The account's token, kept where the rest of the site keeps it

const TOKEN_KEY = 'plume-vault-token';

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* a cleared token is a nicety */ }
}

async function call(path, options = {}) {
  const res = await fetch(api + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${state.token}`,
    },
  });
  if (res.status === 401) {
    forgetToken();
    location.href = 'app.html';
    throw new Error('Signed out');
  }
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch { /* the status will do */ }
    throw new Error(message);
  }
  return res;
}

const callJson = async (path, options) => (await call(path, options)).json();

// ---------------------------------------------------------------------------
// Shaping the flat file list into vaults and folders
//
// The account stores one flat list of paths, `Vault name/folder/note.md`. The
// first segment is the vault; the rest is a tree inside it.

function vaultsOf(files) {
  const seen = new Map();
  for (const file of files) {
    const name = String(file.path).split('/')[0];
    if (!name) continue;
    const row = seen.get(name) || { name, documents: 0, bytes: 0 };
    row.documents += 1;
    row.bytes += file.size || 0;
    seen.set(name, row);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function treeOf(files, vault) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = String(file.path).split('/');
    if (parts.shift() !== vault) continue;
    const name = parts.pop();
    let node = root;
    for (const dir of parts) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push({ ...file, name });
  }
  const sort = node => {
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    node.dirs = new Map([...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    for (const child of node.dirs.values()) sort(child);
  };
  sort(root);
  return root;
}

const isMarkdown = p => /\.(md|markdown)$/i.test(p);
const titleOf = p => String(p).split('/').pop().replace(/\.(md|markdown)$/i, '');

// ---------------------------------------------------------------------------
// Painting

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...kids.filter(Boolean));
  return node;
}

function paintVaults() {
  const list = $('#w-vaults');
  list.replaceChildren();
  const vaults = vaultsOf(state.files);

  if (!vaults.length) {
    list.append(el('p', { class: 'w-empty', text: 'No vaults in your account yet.' }));
    return;
  }

  for (const vault of vaults) {
    const row = el('button', {
      class: `w-vault${vault.name === state.vault ? ' is-current' : ''}`,
      type: 'button',
      onclick: () => {
        state.vault = vault.name;
        paintVaults();
        paintTree();
      },
    },
    el('b', { text: vault.name }),
    el('span', { text: `${vault.documents} document${vault.documents === 1 ? '' : 's'}` }));
    list.append(row);
  }
}

function folderNode(name, node, depth) {
  const open = el('details', { class: 'w-folder', open: depth < 1 ? '' : null });
  open.append(el('summary', { text: name }));
  const inner = el('div', { class: 'w-folder-body' });
  for (const [child, sub] of node.dirs) inner.append(folderNode(child, sub, depth + 1));
  for (const file of node.files) inner.append(fileRow(file));
  open.append(inner);
  return open;
}

function fileRow(file) {
  const current = state.doc && state.doc.path === file.path;
  return el('button', {
    class: `w-file${current ? ' is-current' : ''}${isMarkdown(file.path) ? '' : ' is-other'}`,
    type: 'button',
    title: file.path,
    onclick: () => openDoc(file.path),
  }, el('span', { text: isMarkdown(file.name) ? titleOf(file.name) : file.name }));
}

function paintTree() {
  const tree = $('#w-tree');
  tree.replaceChildren();
  $('#w-tree-title').textContent = state.vault || '';

  if (!state.vault) return;

  const want = state.query.trim().toLowerCase();
  if (want) {
    const hits = state.files
      .filter(f => f.path.startsWith(`${state.vault}/`) && f.path.toLowerCase().includes(want))
      .slice(0, 200);
    if (!hits.length) {
      tree.append(el('p', { class: 'w-empty', text: 'Nothing matches that.' }));
      return;
    }
    for (const file of hits) {
      tree.append(fileRow({ ...file, name: file.path.split('/').pop() }));
    }
    return;
  }

  const root = treeOf(state.files, state.vault);
  for (const [name, node] of root.dirs) tree.append(folderNode(name, node, 0));
  for (const file of root.files) tree.append(fileRow(file));
  if (!root.dirs.size && !root.files.length) {
    tree.append(el('p', { class: 'w-empty', text: 'This vault is empty.' }));
  }
}

// ---------------------------------------------------------------------------
// Reading a document
//
// The wiki map is built from the account's own file list rather than from a
// search: every `[[target]]` is matched against the documents in the same
// vault, which is the same rule the desktop app uses inside a vault.

function wikiMapFor(targets, vault) {
  const inVault = state.files.filter(f => f.path.startsWith(`${vault}/`) && isMarkdown(f.path));
  const byName = new Map();
  for (const file of inVault) {
    const name = titleOf(file.path).toLowerCase();
    if (!byName.has(name)) byName.set(name, file.path);
    byName.set(file.path.slice(vault.length + 1).toLowerCase(), file.path);
  }
  const map = {};
  for (const target of targets) {
    // splitWiki peels off a `|alias`; the `#heading` after it is a place in the
    // note, not part of its name, so it is not part of the lookup either.
    const { target: named } = splitWiki(target);
    const [page, ...rest] = String(named).split('#');
    const want = page.trim().toLowerCase();
    const hit = byName.get(want) || byName.get(`${want}.md`);
    if (hit) map[target] = { path: hit, isMarkdown: true, hash: rest.join('#') };
  }
  return map;
}

async function openDoc(path, { push = true } = {}) {
  if (!(await mayLeave())) return;

  if (!isMarkdown(path)) {
    // Anything that is not Markdown is handed over rather than rendered: the
    // browser already knows what to do with a PNG or a PDF.
    const res = await call(`/vault/file?path=${encodeURIComponent(path)}`);
    const url = URL.createObjectURL(await res.blob());
    const a = el('a', { href: url, download: path.split('/').pop() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return;
  }

  setBusy(true);
  try {
    const res = await call(`/vault/file?path=${encodeURIComponent(path)}`);
    const text = await res.text();
    // The revision this was read at. It goes back with the save so that a
    // change made on another machine in the meantime is refused rather than
    // flattened — the same bargain the desktop app's sync makes.
    state.doc = { path, text, dirty: false, sha: res.headers.get('X-Plume-Sha256') || null };
    state.editing = false;
    state.vault = path.split('/')[0];
    if (push) history.replaceState(null, '', `#${encodeURIComponent(path)}`);
    paintVaults();
    paintTree();
    renderDoc();
  } catch (err) {
    say(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

function renderDoc() {
  const doc = state.doc;
  const body = $('#w-doc');
  const empty = $('#w-empty');

  document.body.classList.toggle('w-has-doc', Boolean(doc));
  if (!doc) {
    empty.hidden = false;
    body.hidden = true;
    $('#w-crumb').textContent = '';
    return;
  }

  empty.hidden = true;
  body.hidden = false;

  const segments = doc.path.split('/');
  $('#w-crumb').replaceChildren(
    el('span', { class: 'w-crumb-vault', text: segments[0] }),
    ...segments.slice(1).map((s, i, all) => el('span', {
      class: i === all.length - 1 ? 'w-crumb-file' : 'w-crumb-dir',
      text: i === all.length - 1 ? titleOf(s) : s,
    })),
  );

  document.title = `${titleOf(doc.path)} — Plume`;
  $('#w-save').hidden = !doc.dirty;
  $('#w-edit').setAttribute('aria-pressed', String(state.editing));
  $('#w-editor').hidden = !state.editing;
  $('#w-article').hidden = state.editing;
  $('#w-stats').textContent = '';

  if (state.editing) {
    const area = $('#w-editor');
    if (area.value !== doc.text) area.value = doc.text;
    area.focus({ preventScroll: true });
    return;
  }

  let out;
  try {
    out = markdown().render(doc.text, { srcMap: false });
  } catch {
    out = { html: '', wiki: [], frontMatter: null };
  }

  const article = $('#w-article');
  article.innerHTML = DOMPurify.sanitize(out.html, { USE_PROFILES: { html: true, svg: true, mathMl: true } });

  try {
    enhance(article, {
      wikiMap: wikiMapFor(out.wiki || [], state.vault),
      frontMatter: out.frontMatter,
    });
    assignHeadingIds(article);
  } catch { /* an un-enhanced document still reads */ }

  // Images live in the account, not on this origin, so each one is fetched
  // with the token and swapped for a blob the browser can show.
  for (const img of article.querySelectorAll('img[src]')) loadImage(img);

  // Wiki links are ours to follow; everything else is an ordinary link.
  for (const a of article.querySelectorAll('a.wikilink[data-wiki]')) {
    a.addEventListener('click', ev => {
      ev.preventDefault();
      const hit = wikiMapFor([a.dataset.wiki], state.vault)[a.dataset.wiki];
      if (hit) openDoc(hit.path);
      else say(`No note named “${wikiLabel(a.dataset.wiki)}” in this vault`);
    });
  }
  for (const a of article.querySelectorAll('a[href]')) {
    if (a.classList.contains('wikilink')) continue;
    const href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:|#)/i.test(href)) {
      if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      continue;
    }
    // A relative link points at another document in the same vault.
    a.addEventListener('click', ev => {
      ev.preventDefault();
      const here = state.doc.path.split('/').slice(0, -1).join('/');
      const target = normalise(`${here}/${href}`.replace(/#.*$/, ''));
      const hit = state.files.find(f => f.path === target);
      if (hit) openDoc(hit.path);
      else say('That link points outside your account');
    });
  }

  const words = plainText(article).split(/\s+/).filter(Boolean).length;
  $('#w-stats').textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}`;
  $('#w-pane').scrollTop = 0;
}

function normalise(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

async function loadImage(img) {
  const src = img.getAttribute('src') || '';
  if (/^(https?:|data:|blob:)/i.test(src)) return;
  const here = state.doc.path.split('/').slice(0, -1).join('/');
  const target = normalise(`${here}/${decodeURIComponent(src)}`);
  try {
    const res = await call(`/vault/file?path=${encodeURIComponent(target)}`);
    img.src = URL.createObjectURL(await res.blob());
  } catch {
    img.replaceWith(el('span', { class: 'w-missing', text: `[missing image: ${src}]` }));
  }
}

// ---------------------------------------------------------------------------
// Editing

async function mayLeave() {
  if (!state.doc || !state.doc.dirty) return true;
  return window.confirm('This note has unsaved changes. Leave it?');
}

function toggleEdit() {
  if (!state.doc) return;
  state.editing = !state.editing;
  renderDoc();
}

async function save() {
  const doc = state.doc;
  if (!doc || !doc.dirty) return;
  setBusy(true);
  try {
    const headers = { 'Content-Type': 'text/markdown; charset=utf-8' };
    if (doc.sha) headers['X-Plume-Base-Sha'] = doc.sha;
    const res = await call(`/vault/file?path=${encodeURIComponent(doc.path)}`, {
      method: 'PUT',
      headers,
      body: doc.text,
    });
    const saved = await res.json().catch(() => null);
    doc.sha = (saved && saved.sha256) || res.headers.get('X-Plume-Sha256') || null;
    doc.dirty = false;
    say('Saved');
    renderDoc();
    refreshList({ quiet: true });
  } catch (err) {
    // A refused write is the interesting case: somebody else changed this note
    // while it was open here, and nothing has been lost yet.
    if (/conflict|base|changed/i.test(err.message)) {
      say('This note changed somewhere else while you were editing. '
        + 'Copy your text, press Refresh, and merge it in.', 'error');
    } else {
      say(`Could not save: ${err.message}`, 'error');
    }
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Chrome

let sayTimer = null;
function say(message, kind) {
  const box = $('#w-toast');
  box.textContent = message;
  box.className = `w-toast${kind ? ` is-${kind}` : ''} is-up`;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => box.classList.remove('is-up'), 2600);
}

function setBusy(on) {
  document.body.classList.toggle('w-busy', on);
}

async function refreshList({ quiet = false } = {}) {
  try {
    const body = await callJson('/vault/list');
    state.files = Array.isArray(body.files) ? body.files : [];
    paintAccount(body.account);
    if (!state.vault) {
      const first = vaultsOf(state.files)[0];
      state.vault = first ? first.name : null;
    }
    paintVaults();
    paintTree();
    if (!quiet) say(`${state.files.length} document${state.files.length === 1 ? '' : 's'}`);
  } catch (err) {
    say(err.message, 'error');
  }
}

function paintAccount(account) {
  if (!account) return;
  state.account = account;
  const used = Number(account.usedBytes) || 0;
  const cap = Number(account.quotaBytes) || 0;
  $('#w-who').textContent = account.email || '';
  if (cap) {
    $('#w-quota').textContent = `${fmtBytes(used)} of ${fmtBytes(cap)} used`;
    $('#w-meter').style.width = `${Math.min(100, (used / cap) * 100).toFixed(1)}%`;
  }
}

async function loadAccount() {
  const body = await callJson('/me');
  paintAccount(body.account);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function wire() {
  $('#w-edit').addEventListener('click', toggleEdit);
  $('#w-save').addEventListener('click', () => save());
  $('#w-refresh').addEventListener('click', () => refreshList());
  $('#w-sidebar-toggle').addEventListener('click', () => {
    document.body.classList.toggle('w-sidebar-off');
  });

  $('#w-editor').addEventListener('input', ev => {
    if (!state.doc) return;
    state.doc.text = ev.target.value;
    state.doc.dirty = true;
    $('#w-save').hidden = false;
  });

  $('#w-search').addEventListener('input', ev => {
    state.query = ev.target.value;
    paintTree();
  });

  document.addEventListener('keydown', ev => {
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      save();
    } else if (ctrl && ev.key.toLowerCase() === 'e') {
      ev.preventDefault();
      toggleEdit();
    } else if (ctrl && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      $('#w-search').focus();
      $('#w-search').select();
    }
  });

  // A link to a note, followed while the view is already open: the browser
  // changes the fragment without reloading, so the page has to notice.
  window.addEventListener('hashchange', () => {
    const wanted = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    if (!wanted) return;
    if (state.doc && state.doc.path === wanted) return;
    if (!state.files.some(f => f.path === wanted)) {
      say('That note is not in your account');
      return;
    }
    openDoc(wanted, { push: false });
  });

  window.addEventListener('beforeunload', ev => {
    if (state.doc && state.doc.dirty) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
}

async function boot() {
  state.token = readToken();
  if (!state.token) {
    location.href = 'app.html';
    return;
  }

  wire();
  try {
    await loadAccount();
  } catch (err) {
    say(err.message, 'error');
    return;
  }
  await refreshList({ quiet: true });

  // A link straight to a document — what you send somebody.
  const wanted = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  if (wanted && state.files.some(f => f.path === wanted)) await openDoc(wanted, { push: false });
  else renderDoc();

  document.body.classList.remove('w-booting');
}

boot().catch(err => {
  console.error(err);
  document.body.classList.remove('w-booting');
});
