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

const API = (process.env.PLUME_VAULT_API || 'https://plume-md.com/api').replace(/\/+$/, '');
const TIMEOUT_MS = 30_000;
const MAX_PUSH_BYTES = 10 * 1024 * 1024;

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
const SKIP_DIR = /^[.]|^node_modules$|^__pycache__$/;

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

/** Every syncable document under a folder, with the vault path each would take. */
async function collectFolder(dir, rootDir, depth = 0) {
  const found = [];
  if (depth > MAX_DEPTH) return found;

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return found;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue;
      found.push(...(await collectFolder(full, rootDir, depth + 1)));
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
async function pushMany(items, { force = false, onProgress } = {}) {
  requireSession();

  const done = [];
  const failed = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (onProgress) onProgress({ index: i, total: items.length, localPath: item.localPath });
    try {
      const result = await push(item.localPath, item.vaultPath, { force });
      done.push({ ...result, vaultPath: item.vaultPath });
    } catch (err) {
      failed.push({
        localPath: item.localPath,
        vaultPath: item.vaultPath,
        error: err && err.message ? err.message : 'Could not sync that document.',
        status: err && err.status,
        conflict: err && err.conflict,
      });
    }
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

/**
 * Sends a local file up. When the vault copy has moved on since this machine
 * last synced, the push is refused and the conflict is handed back rather than
 * overwriting work done elsewhere.
 */
async function push(localPath, vaultPath, { force = false } = {}) {
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
  const target = vaultPath || (links[localPath] && links[localPath].vaultPath) || suggestVaultPath(localPath);
  const known = links[localPath];

  const headers = {};
  if (!force && known && known.vaultPath === target) headers['X-Plume-Base-Sha'] = known.sha256;

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

/** Brings a vault document down to a local path. */
async function pull(vaultPath, destPath) {
  requireSession();
  const res = await call(`/vault/file?path=${encodeURIComponent(vaultPath)}`);
  const body = Buffer.from(await res.arrayBuffer());

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, body);

  links[destPath] = {
    vaultPath,
    sha256: res.headers.get('x-plume-sha256') || sha256(body),
    syncedAt: res.headers.get('x-plume-updated-at') || new Date().toISOString(),
  };
  saveLinks();

  return { localPath: destPath, vaultPath, size: body.length };
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

module.exports = {
  API,
  publicState,
  signUp,
  signIn,
  signOut,
  refresh,
  list,
  graph,
  push,
  pull,
  saveConflictCopy,
  remove,
  unlink,
  linkFor,
  isSyncable,
  suggestVaultPath,
  collectFolder,
  pushMany,
  SYNCABLE,
};
