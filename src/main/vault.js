'use strict';

// Plume Vault — the desktop half of document sync.
//
// All of it runs in the main process on purpose: the renderer stays sandboxed
// behind its Content-Security-Policy and never learns the account token. The
// renderer only ever asks for an action and gets back a plain result object.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

// The override is a development affordance. In a packaged build it is ignored:
// anything running as this user can set an environment variable, and this is
// where the account password goes.
function resolveApi() {
  const DEFAULT = 'https://plume-md.com/api';
  const override = process.env.PLUME_VAULT_API;
  // `app` is undefined when this module is loaded outside Electron, which is
  // how the unit tests reach it. Reading `isPackaged` off it threw before the
  // override was even considered, so a test run with PLUME_VAULT_API set — the
  // way the end-to-end runs set it — could not load this file at all.
  if (!override || (app && app.isPackaged)) return DEFAULT;
  try {
    const url = new URL(override);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !local) return DEFAULT;
    return override.replace(/\/+$/, '');
  } catch (err) {
    return DEFAULT;
  }
}

const API = resolveApi();
const TIMEOUT_MS = 30_000;
const MAX_PUSH_BYTES = 10 * 1024 * 1024;
const MAX_PULL_BYTES = 10 * 1024 * 1024;

const SYNCABLE = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext', '.txt']);

let session = null;   // { token, email, account }
let links = null;     // { [localPath]: { vaultPath, sha256, syncedAt } }

// ---------- where state lives ----------

const sessionFile = () => path.join(app.getPath('userData'), 'vault-session.bin');
const linksFile = () => path.join(app.getPath('userData'), 'vault-links.json');

function writeAtomic(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

// The token is kept encrypted at rest wherever the OS offers it (Keychain,
// DPAPI, libsecret). Where it does not, we store nothing rather than leaving a
// bearer token in plain text on disk — the user signs in again next launch.
function saveSession() {
  try {
    if (!session) {
      fs.rmSync(sessionFile(), { force: true });
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) return;
    writeAtomic(sessionFile(), safeStorage.encryptString(JSON.stringify(session)));
  } catch {
    // Signing in again is a small price; never crash over it.
  }
}

function loadSession() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const raw = fs.readFileSync(sessionFile());
    const parsed = JSON.parse(safeStorage.decryptString(raw));
    if (parsed && typeof parsed.token === 'string' && typeof parsed.email === 'string') return parsed;
  } catch {
    // No session, or it was written by a different user or machine.
  }
  return null;
}

function saveLinks() {
  try {
    writeAtomic(linksFile(), JSON.stringify(links, null, 2));
  } catch {
    // Links are a convenience; losing them only means re-choosing a name.
  }
}

function loadLinks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(linksFile(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const clean = {};
      for (const [local, meta] of Object.entries(parsed)) {
        if (meta && typeof meta.vaultPath === 'string' && typeof meta.sha256 === 'string') {
          clean[local] = { vaultPath: meta.vaultPath, sha256: meta.sha256, syncedAt: meta.syncedAt || null };
        }
      }
      return clean;
    }
  } catch {
    // Starting fresh.
  }
  return {};
}

function ready() {
  if (!session) session = loadSession();
  if (!links) links = loadLinks();
}

// ---------- talking to the API ----------

/** How long the server asked us to wait, in milliseconds, within reason. */
function retryAfter(res) {
  const header = res.headers.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(60000, seconds * 1000);
  return 2000;
}

async function call(endpoint, { method = 'GET', body, json, headers = {}, auth = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const sent = { ...headers };
  if (auth && session) sent.Authorization = `Bearer ${session.token}`;
  if (json !== undefined) sent['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(API + endpoint, {
      method,
      headers: sent,
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('The vault did not answer in time. Check your connection.');
    throw new Error('Could not reach the vault. Check your connection.');
  }
  clearTimeout(timer);

  if (res.status === 401 && auth) {
    session = null;
    saveSession();
    throw new Error('Your session expired. Sign in again.');
  }

  // The vault asks callers to slow down rather than refusing them outright.
  // Syncing a real notebook is hundreds of uploads in a row, so a sync that
  // treated 429 as a failure simply stopped partway through and reported a
  // number with no reason attached.
  if (res.status === 429) {
    const err = new Error('The vault asked us to slow down.');
    err.status = 429;
    err.retryAfterMs = retryAfter(res);
    throw err;
  }

  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `The vault refused that (${res.status}).`);
      err.status = res.status;
      err.conflict = data.conflict;
      err.usage = data.usage;
      throw err;
    }
    return data;
  }

  if (!res.ok) {
    const err = new Error(`The vault refused that (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ---------- account ----------

function publicState() {
  ready();
  return {
    api: API,
    signedIn: Boolean(session),
    email: session ? session.email : null,
    account: session ? session.account : null,
    encrypted: safeStorage.isEncryptionAvailable(),
  };
}

async function signUp(email, password) {
  const data = await call('/auth/signup', { method: 'POST', json: { email, password }, auth: false });
  session = { token: data.token, email: data.account.email, account: data.account };
  saveSession();
  return publicState();
}

async function signIn(email, password) {
  const data = await call('/auth/login', { method: 'POST', json: { email, password }, auth: false });
  session = { token: data.token, email: data.account.email, account: data.account };
  saveSession();
  return publicState();
}

function signOut() {
  session = null;
  saveSession();
  return publicState();
}

async function refresh() {
  ready();
  if (!session) return publicState();
  const data = await call('/vault/list');
  session.account = data.account;
  saveSession();
  return { ...publicState(), files: data.files };
}

// ---------- documents ----------

function requireSession() {
  ready();
  if (!session) throw new Error('Sign in to your vault first.');
}

const MAX_DEPTH = 10;
const MAX_COLLECT = 2000;
const MAX_VAULT_PATH = 400;
const SKIP_DIR = /^[.]|^node_modules$|^__pycache__$|^[$]RECYCLE/i;

/**
 * Where a file should live in the vault.
 *
 * Keeping only the file name flattens a notebook: two documents called
 * `README` in different folders become one, and nothing in the graph can tell
 * which folder a note came from. So the path is taken relative to the folder
 * the user is syncing from, and only falls back to the bare name when the file
 * sits outside it.
 */
function suggestVaultPath(localPath, rootDir) {
  const name = path.basename(localPath);
  if (!rootDir) return name;

  const relative = path.relative(rootDir, localPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return name;

  const parts = relative.split(path.sep).filter(Boolean);
  // The server accepts twelve segments; past that, keep the deepest ones that
  // still say something useful.
  const trimmed = parts.length > 12 ? parts.slice(parts.length - 12) : parts;
  return trimmed.join('/');
}

/**
 * The only shape a vault path may take: relative, forward slashes, no step
 * outside. suggestVaultPath can never produce anything else, but a name typed
 * into the panel can, and the server is entitled to assume it cannot.
 */
function cleanVaultPath(raw) {
  const p = String(raw == null ? '' : raw).split('\\').join('/').trim();
  if (!p || p.length > MAX_VAULT_PATH) throw new Error('That is not a usable name for the vault.');
  for (let i = 0; i < p.length; i += 1) {
    const code = p.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw new Error('That name contains control characters.');
  }
  if (p.startsWith('/') || /^[a-z]:/i.test(p)) throw new Error('A vault name cannot be an absolute path.');

  const parts = p.split('/').filter(Boolean);
  if (!parts.length || parts.some(seg => seg === '.' || seg === '..')) {
    throw new Error('A vault name cannot step outside the vault.');
  }
  if (parts.length > 12) throw new Error('That path is nested too deeply for the vault.');
  return parts.join('/');
}

/** Every syncable document under a folder, with the vault path each would take. */
async function collectFolder(dir, rootDir, depth = 0, found = []) {
  if (depth > MAX_DEPTH || found.length >= MAX_COLLECT) return found;

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return found;
  }

  for (const entry of entries) {
    if (found.length >= MAX_COLLECT) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue;
      await collectFolder(full, rootDir, depth + 1, found);
    } else if (entry.isFile() && SYNCABLE.has(path.extname(entry.name).toLowerCase())) {
      found.push({ localPath: full, vaultPath: suggestVaultPath(full, rootDir) });
    }
  }
  return found;
}

/**
 * Sends several documents up, one after another rather than all at once: the
 * vault serialises writes per account anyway, and a failure partway through
 * should leave a clear account of what did and did not go.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends many documents, one at a time, slowly enough that the vault does not
 * have to ask us to stop — and waiting rather than giving up when it does.
 *
 * A notebook of a thousand documents is a thousand requests. Sent as fast as
 * the network allows, that trips the vault's own per-account limit a few
 * hundred in, and everything after it fails. Which is exactly what it looked
 * like: hundreds of documents "could not be synced", no reason given, and a
 * folder that never finished.
 */
async function pushMany(items, { force = false, onProgress } = {}) {
  requireSession();

  const done = [];
  const failed = [];
  // Comfortably under the vault's per-account ceiling, and invisible next to
  // the time an upload takes anyway.
  const SPACING_MS = 120;
  const MAX_WAITS = 5;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (onProgress) onProgress({ index: i, total: items.length, localPath: item.localPath });

    let sent = false;
    for (let attempt = 0; attempt <= MAX_WAITS && !sent; attempt += 1) {
      try {
        const result = await push(item.localPath, item.vaultPath, { force });
        done.push({ ...result, vaultPath: item.vaultPath });
        sent = true;
      } catch (err) {
        const askedToWait = err && (err.status === 429 || err.status === 409 && /too quickly/i.test(err.message || ''));
        if (askedToWait && attempt < MAX_WAITS) {
          await wait((err.retryAfterMs || 2000) * (attempt + 1));
          continue;
        }
        failed.push({
          localPath: item.localPath,
          vaultPath: item.vaultPath,
          error: err && err.message ? err.message : 'Could not sync that document.',
          status: err && err.status,
          conflict: err && err.conflict,
        });
        sent = true;
      }
    }

    if (i + 1 < items.length) await wait(SPACING_MS);
  }

  return { done, failed, account: session ? session.account : null };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function graph() {
  requireSession();
  const data = await call('/vault/graph');
  session.account = data.account;
  return { nodes: data.nodes, edges: data.edges, unresolved: data.unresolved, account: data.account };
}

async function list() {
  requireSession();
  const data = await call('/vault/list');
  session.account = data.account;
  return { files: data.files, account: data.account, links: { ...links } };
}

// ---------- remote vaults ----------

// The account holds a flat, content-addressed store keyed by path. A remote
// vault is the top-level folder of that store: every document in it begins
// with the vault's remote name. That is the whole of the mapping, and it is
// what lets one account hold any number of vaults against a single quota
// without the server having to know what a vault is.
//
// Keeping it to one segment is the part that matters. Two vaults can hold a
// `Notes/today.md` each and never meet, and cloning one is "everything under
// this prefix" rather than a list the client has to be trusted to assemble.

const MAX_REMOTE_NAME = 120;

/** A top-level folder name the vault will accept, from a vault's name. */
function remoteNameFrom(name) {
  const flat = String(name || '').replace(/[\\/]+/g, ' ').trim();
  const clean = [...flat]
    .filter(ch => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .replace(/^[.]+/, '')
    .trim();
  return clean.slice(0, MAX_REMOTE_NAME) || 'Vault';
}

/** The same, but not one already in use by another remote vault. */
function freeRemoteName(name, taken) {
  const base = remoteNameFrom(name);
  const used = new Set((taken || []).map(n => String(n).toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** The top-level segment of a vault path, which names the remote vault. */
function remoteOf(vaultPath) {
  const parts = String(vaultPath || '').split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : '';
}

/**
 * The vaults in the account, assembled from the store's top-level folders.
 *
 * Documents sitting at the top level with no folder of their own belong to no
 * vault: they are what one-off pushes and older versions of Plume left behind.
 * They are reported under a null name so the panel can still show them rather
 * than pretending the account is emptier than it is.
 */
async function remoteVaults() {
  requireSession();
  const data = await call('/vault/list');
  session.account = data.account;

  const byName = new Map();
  for (const f of data.files || []) {
    const name = remoteOf(f.path);
    if (!byName.has(name)) byName.set(name, { name: name || null, documents: 0, bytes: 0, updatedAt: null });
    const row = byName.get(name);
    row.documents += 1;
    row.bytes += f.size || 0;
    if (!row.updatedAt || (f.updatedAt && f.updatedAt > row.updatedAt)) row.updatedAt = f.updatedAt;
  }

  const vaults = [...byName.values()].sort((a, b) => {
    if (!a.name) return 1;
    if (!b.name) return -1;
    return a.name.localeCompare(b.name);
  });
  return { vaults, account: data.account, files: data.files || [] };
}

/**
 * Deletes a remote vault and everything in it. Destructive, and the only
 * thing here that frees quota — which is exactly why it is its own named
 * action rather than something unlinking does on the way past.
 */
async function removeRemote(remoteName, onProgress) {
  requireSession();
  // Taken as given. The caller canonicalises before it confirms, so
  // normalising again here would act on a different vault than the one the
  // person was shown — " Notes " and ".Notes" both land on "Notes".
  const name = String(remoteName);
  const data = await call('/vault/list');
  const mine = (data.files || []).filter(f => remoteOf(f.path) === name);

  let done = 0;
  const failed = [];
  for (const f of mine) {
    try {
      await remove(f.path);
    } catch (err) {
      failed.push({ path: f.path, error: err && err.message });
    }
    done += 1;
    if (onProgress) onProgress({ done, total: mine.length });
    await wait(80);
  }
  return { removed: done - failed.length, failed, account: session ? session.account : null };
}

/**
 * Sends a local file up. When the vault copy has moved on since this machine
 * last synced, the push is refused and the conflict is handed back rather than
 * overwriting work done elsewhere.
 *
 * `baseSha` is what the caller last saw of the remote copy. A vault passes its
 * manifest entry, which is the record that makes its sync a sync; a one-off
 * push of a loose document has no manifest and falls back to the links file.
 */
async function push(localPath, vaultPath, { force = false, baseSha } = {}) {
  requireSession();

  const ext = path.extname(localPath).toLowerCase();
  if (!SYNCABLE.has(ext)) {
    throw new Error('Plume syncs Markdown and text documents.');
  }

  const stat = await fsp.stat(localPath);
  if (stat.size > MAX_PUSH_BYTES) {
    throw new Error(`That document is larger than the ${Math.round(MAX_PUSH_BYTES / 1048576)} MB limit.`);
  }

  const body = await fsp.readFile(localPath);
  const target = cleanVaultPath(vaultPath || (links[localPath] && links[localPath].vaultPath) || suggestVaultPath(localPath));
  const known = links[localPath];

  const headers = {};
  if (!force) {
    // An explicit base beats the links file: it is the vault's own record of
    // what the remote held, and it is the one kept in step with the manifest.
    if (typeof baseSha === 'string' && baseSha) headers['X-Plume-Base-Sha'] = baseSha;
    else if (baseSha === undefined && known && known.vaultPath === target) {
      headers['X-Plume-Base-Sha'] = known.sha256;
    }
  }

  const data = await call(`/vault/file?path=${encodeURIComponent(target)}`, {
    method: 'PUT',
    body,
    headers,
  });

  links[localPath] = { vaultPath: target, sha256: data.file.sha256, syncedAt: data.file.updatedAt };
  saveLinks();
  session.account = data.account;

  return { file: data.file, account: data.account, unchanged: data.unchanged, localPath };
}

/**
 * Brings a vault document down to a local path.
 *
 * `within` is the folder the write must land in. The caller works that out and
 * checks it too, but this is a public function that writes server-chosen bytes
 * to a path derived from a server-chosen string — it should not be safe only
 * because of who happens to call it.
 */
async function pull(vaultPath, destPath, { within = null } = {}) {
  requireSession();

  if (within) {
    const root = path.resolve(within);
    const abs = path.resolve(destPath);
    const relative = path.relative(root, abs);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('That document will not stay inside the vault.');
    }
  }

  const res = await call(`/vault/file?path=${encodeURIComponent(vaultPath)}`);

  // A length the server declares, and then the length it actually sent. The
  // upload side has had a ceiling all along; without one here a single reply
  // can take the main process down, and nothing but the server decides how
  // big it is.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PULL_BYTES) {
    throw new Error(`That document is larger than the ${Math.round(MAX_PULL_BYTES / 1048576)} MB limit.`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_PULL_BYTES) {
    throw new Error(`That document is larger than the ${Math.round(MAX_PULL_BYTES / 1048576)} MB limit.`);
  }

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, body);

  const hash = res.headers.get('x-plume-sha256') || sha256(body);
  const updatedAt = res.headers.get('x-plume-updated-at') || new Date().toISOString();

  links[destPath] = { vaultPath, sha256: hash, syncedAt: updatedAt };
  saveLinks();

  return { localPath: destPath, vaultPath, size: body.length, sha256: hash, updatedAt };
}

/** Saves the vault copy next to the local one so neither version is lost. */
async function saveConflictCopy(localPath, vaultPath) {
  const dir = path.dirname(localPath);
  const ext = path.extname(localPath);
  const base = path.basename(localPath, ext);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const dest = path.join(dir, `${base} (vault copy ${stamp})${ext}`);
  await pull(vaultPath, dest);
  return dest;
}

async function remove(vaultPath) {
  requireSession();
  const data = await call(`/vault/file?path=${encodeURIComponent(vaultPath)}`, { method: 'DELETE' });
  for (const [local, meta] of Object.entries(links)) {
    if (meta.vaultPath === vaultPath) delete links[local];
  }
  saveLinks();
  session.account = data.account;
  return { account: data.account };
}

function unlink(localPath) {
  ready();
  delete links[localPath];
  saveLinks();
  return { links: { ...links } };
}

/** What the renderer needs to know about the document it is showing. */
function linkFor(localPath) {
  ready();
  if (!localPath) return null;
  const meta = links[localPath];
  return meta ? { ...meta } : null;
}

function isSyncable(localPath) {
  return SYNCABLE.has(path.extname(localPath || '').toLowerCase());
}

/**
 * Tells the vault that this account syncs a folder with Git, and which
 * repository — so the web vault can say so too. Never a credential: the server
 * strips anything before the "@" of a remote, and nothing here sends a token
 * because nothing here has one.
 *
 * Best effort. Git sync works whether or not the vault hears about it, so a
 * failure is logged and forgotten rather than surfaced.
 */
async function reportGit(status) {
  if (!session) return null;
  try {
    return await call('/git/status', { method: 'PUT', json: status });
  } catch (err) {
    return null;
  }
}

module.exports = {
  API,
  publicState,
  reportGit,
  signUp,
  signIn,
  signOut,
  refresh,
  list,
  remoteVaults,
  removeRemote,
  remoteNameFrom,
  freeRemoteName,
  remoteOf,
  graph,
  push,
  pull,
  remove,
  unlink,
  linkFor,
  isSyncable,
  suggestVaultPath,
  cleanVaultPath,
  SYNCABLE,
};
